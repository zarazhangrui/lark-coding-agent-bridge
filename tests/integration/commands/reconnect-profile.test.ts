import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('/reconnect profile lifecycle', () => {
  it('stops current profile runs before reconnect by default', async () => {
    const h = await createHarness();
    const run = new ManualRun('run-1');
    h.activeRuns.register('chat-1', run);

    await expect(h.command('/reconnect')).resolves.toBe(true);

    expect(run.stopCalls).toBe(1);
    expect(run.waitForExitCalls).toBe(0);
    expect(h.restart).toHaveBeenCalledWith({ wait: false });
  });

  it('waits for current runs when --wait is requested', async () => {
    const h = await createHarness();
    const run = new ManualRun('run-1');
    h.activeRuns.register('chat-1', run);

    await expect(h.command('/reconnect --wait')).resolves.toBe(true);

    expect(run.stopCalls).toBe(0);
    expect(run.waitForExitCalls).toBe(1);
    expect(h.restart).toHaveBeenCalledWith({ wait: true });
  });

  it('starts the replacement bridge with replacement controls before swapping globals', async () => {
    const source = await readFile(new URL('../../../src/cli/commands/start.ts', import.meta.url), 'utf8');

    expect(source).toContain('const nextControls = makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig)');
    expect(source).toContain('controls: nextControls');
    expect(source).toContain('controls = nextControls');
  });

  it('guards direct bridge disconnects and IM commands with the current profile runtime context', async () => {
    const source = await readFile(new URL('../../../src/bot/channel.ts', import.meta.url), 'utf8');
    const disconnectBlock = source.slice(
      source.indexOf('disconnect: async () => {'),
      source.indexOf('async function commandSessionCatalogIdentity'),
    );

    expect(source).toContain("activeRuns.pauseNewRuns('bridge-disconnect')");
    expect(disconnectBlock).not.toContain('resumeNewRuns');
    expect(disconnectBlock).toContain('await Promise.allSettled([');
    expect(disconnectBlock).toContain('channel.disconnect()');
    expect(disconnectBlock).toContain('activeRuns.stopAll()');
    expect(source).toContain('sessionCatalogIdentity: await commandSessionCatalogIdentity({');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  activeRuns: ActiveRuns;
  restart: ReturnType<typeof vi.fn>;
  command(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile('reconnect-profile-');
  cleanups.push(tmp.cleanup);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  const restart = vi.fn(async () => {});
  const controls = {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart,
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  return {
    tmp,
    activeRuns,
    restart,
    command: (content: string) =>
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

class ManualRun implements AgentRun {
  readonly events: AsyncIterable<never> = {
    async *[Symbol.asyncIterator]() {},
  };
  stopCalls = 0;
  waitForExitCalls = 0;

  constructor(readonly runId: string) {}

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  async waitForExit(): Promise<boolean> {
    this.waitForExitCalls++;
    return true;
  }
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
