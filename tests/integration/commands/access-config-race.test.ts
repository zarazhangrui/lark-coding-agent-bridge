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
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const saveGate = vi.hoisted(() => ({
  calls: 0,
  waiters: [] as Array<() => void>,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  reset(): void {
    this.calls = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.waiters = [];
  },
  releaseWaiters(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiter of this.waiters.splice(0)) waiter();
  },
  waitForFirstTwoSaves(): Promise<void> {
    this.calls += 1;
    if (this.calls > 2) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (this.waiters.length === 2) {
        this.releaseWaiters();
      } else {
        this.timer = setTimeout(() => this.releaseWaiters(), 50);
      }
    });
  },
}));

vi.mock('../../../src/config/profile-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/config/profile-store.js')>();
  return {
    ...actual,
    saveRootConfig: vi.fn(async (...args: Parameters<typeof actual.saveRootConfig>) => {
      await saveGate.waitForFirstTwoSaves();
      return actual.saveRootConfig(...args);
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];

describe('access config concurrent writes', () => {
  afterEach(async () => {
    saveGate.reset();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('merges concurrent access mutations against the latest root config', async () => {
    saveGate.reset();
    const h = await createHarness();

    await Promise.all([
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ]);

    const { loadRootConfig } = await import('../../../src/config/profile-store.js');
    const root = await loadRootConfig(h.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).toContain('ou-alice');
    expect(root?.profiles.claude?.access.admins).toEqual(
      expect.arrayContaining(['ou-admin', 'ou-bob']),
    );
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  configPath: string;
  run(content: string, overrides?: { mentions?: NormalizedMessage['mentions'] }): Promise<boolean>;
}> {
  const tmp = await createTmpProfile('access-config-race-');
  const configPath = join(tmp.root, 'config.json');
  const profileConfig = appConfig(await realpath(tmp.workspace));
  const { createRootConfig } = await import('../../../src/config/profile-store.js');
  await mkdir(tmp.root, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(createRootConfig('claude', profileConfig), null, 2)}\n`);

  const channel = createFakeChannel();
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
    tmp,
    configPath,
    run: (content, overrides = {}) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content, overrides.mentions ?? []),
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

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  mentions: NormalizedMessage['mentions'],
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentions,
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function mention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: false,
  } as NonNullable<NormalizedMessage['mentions']>[number];
}
