import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { CommandContext, Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const NEW_CHAT_ID = 'oc-new-group-xyz';

const cleanups: Array<() => Promise<void>> = [];

describe('/new chat auto-allow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('persists the freshly created group chat_id into allowedChats', async () => {
    const h = await createHarness();

    // The v2 access policy is fail-closed, so the new group starts out unable
    // to reach the bot until it's whitelisted.
    const { loadRootConfig } = await import('../../../src/config/profile-store.js');
    const before = await loadRootConfig(h.configPath);
    expect(before?.profiles.claude?.access.allowedChats ?? []).not.toContain(NEW_CHAT_ID);

    const handled = await h.run('/new chat Demo');
    expect(handled).toBe(true);
    expect(h.createdChatNames).toContain('Demo');

    const after = await loadRootConfig(h.configPath);
    expect(after?.profiles.claude?.access.allowedChats).toContain(NEW_CHAT_ID);
  });

  it('is idempotent when the chat_id is already allowed', async () => {
    const h = await createHarness({ preAllow: [NEW_CHAT_ID] });

    const handled = await h.run('/new chat Again');
    expect(handled).toBe(true);

    const { loadRootConfig } = await import('../../../src/config/profile-store.js');
    const after = await loadRootConfig(h.configPath);
    const list = after?.profiles.claude?.access.allowedChats ?? [];
    expect(list.filter((id) => id === NEW_CHAT_ID)).toHaveLength(1);
  });
});

async function createHarness(opts: { preAllow?: string[] } = {}): Promise<{
  configPath: string;
  createdChatNames: string[];
  run(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile('new-chat-auto-allow-');
  const configPath = join(tmp.root, 'config.json');
  const profileConfig = appConfig(await realpath(tmp.workspace), opts.preAllow ?? []);
  const { createRootConfig } = await import('../../../src/config/profile-store.js');
  await mkdir(tmp.root, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(createRootConfig('claude', profileConfig), null, 2)}\n`,
  );

  const base = createFakeChannel();
  const createdChatNames: string[] = [];
  const channel = {
    ...base,
    async createChat(params: { name?: string }): Promise<{ chatId: string }> {
      createdChatNames.push(params.name ?? '');
      return { chatId: NEW_CHAT_ID };
    },
  };

  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const { tryHandleCommand } = await import('../../../src/commands/index.js');
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    configPath,
    createdChatNames,
    run: (content) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
  };
}

function appConfig(defaultWorkspace: string, allowedChats: string[]): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-owner'], allowedChats },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-owner',
    senderName: 'Owner',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
