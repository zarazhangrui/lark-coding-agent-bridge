import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('doctor/status visible diagnostics', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows full local cwd and raw scope in status cards', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    await h.command('/status');

    const payload = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(payload).toContain(jsonStringFragment(h.tmp.workspace));
    expect(payload).toContain('chat-1');
  });

  it('keeps doctor self-check replies free of app secrets while showing local paths', async () => {
    const h = await createHarness();
    h.controls.cfg.accounts.app.secret = 'plain-secret-value';
    h.controls.profileConfig.accounts.app.secret = 'plain-secret-value';

    await h.command('/doctor');

    const payload = JSON.stringify(h.channel.sent);
    expect(payload).not.toContain('plain-secret-value');
    expect(payload).toContain(jsonStringFragment(h.tmp.workspace));
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeChannel;
  workspaces: WorkspaceStore;
  controls: Controls;
  command(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile('doctor-redaction-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const controls = {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  return {
    tmp,
    channel,
    workspaces,
    controls,
    command: (content: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'group',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
