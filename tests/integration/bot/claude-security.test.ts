import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth: CallbackAuth;
  token(action: string, nonce?: string): string;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Claude shared security regressions', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('rejects legacy card callback marker payloads instead of forwarding them', async () => {
    const h = await createHarness();

    await handleCardAction({
      channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ __claude_cb: true, choice: 'legacy' }),
      sessions: h.sessions,
      workspaces: h.workspaces,
      activeRuns: h.activeRuns,
      agent: h.agent,
      controls: h.controls,
      pending: h.pending,
      chatModeCache: h.chatModeCache,
    });

    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('forwards signed bridge card callbacks with the real group chat type', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await handleCardAction({
      channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(
        {
          __bridge_cb: true,
          bridge_token: h.token('agent_callback', 'nonce-agent'),
          choice: 'a',
        },
        { note: 'from form' },
      ),
      sessions: h.sessions,
      workspaces: h.workspaces,
      activeRuns: h.activeRuns,
      agent: h.agent,
      controls: h.controls,
      pending: h.pending,
      chatModeCache: h.chatModeCache,
      callbackAuth: h.callbackAuth,
      callbackPolicyFingerprint: 'fp-1',
    });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_operator',
      threadId: undefined,
      content: '[card-click] {"choice":"a","form_value":{"note":"from form"}}',
      rawContentType: 'card_action',
    });
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('claude-security-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = appConfig();
  const pending = new PendingQueue(60_000, () => {});
  const nonceStore = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  let nextNonce = 'nonce-default';
  const callbackAuth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore,
    now: () => 1000,
    createNonce: () => nextNonce,
  });
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const chatModeCache = {
    resolve: async () => 'group',
  } as unknown as ChatModeCache;

  const cleanup = async (): Promise<void> => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), nonceStore.flush()]);
    await tmp.cleanup();
  };
  cleanups.push(cleanup);

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    chatModeCache,
    callbackAuth,
    token: (action, nonce = `nonce-${action}`) => {
      nextNonce = nonce;
      return callbackAuth.sign({
        runId: 'run-active',
        scope: 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    cleanup,
  };
}

function appConfig(): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'] },
  });
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
