import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
  agent: FakeAgentAdapter;
  controls: Controls;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/status and /doctor diagnostics', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows passive status for active run, queue, stale session, and owner API state', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-old', '/old');
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);
    const release = await h.pool.acquire();

    await expect(h.run('/status')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(1);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('旧 cwd');
    expect(status).toContain('active run');
    expect(status).toContain('active scopes');
    expect(status).toContain('1/1 active');
    expect(status).toContain('owner API');
    expect(status).toContain('profile');
    expect(status).toContain('claude');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
  });

  it('runs only self-checks when no cwd is selected', async () => {
    const h = await createHarness({ configuredWorkspace: false, bindWorkspace: false });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('未设置工作目录');
    expect(lastMarkdownOrText(h.channel)).toContain('self-check');
  });

  it('uses RunExecutor for a sessionless read-only agent echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.sessionId).toBeUndefined();
    expect(opts.threadId).toBeUndefined();
    expect(opts.images).toBeUndefined();
    expect(opts.permissionMode).toBe('plan');
    expect(opts.prompt).toContain('OK');
    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('self-check');
    expect(output).toContain('profile');
    expect(output).toContain('claude');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok permission=plan');
    expect(output).not.toContain('permission=bypassPermissions');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
  });

  it('uses the profile default workspace when the chat has no bound cwd', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      bindWorkspace: false,
      defaultWorkspace: true,
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringContent(h.tmp.workspace));
    expect(status).not.toContain('工作目录已选择');
  });

  it('fast-fails the agent echo check when the process pool is full', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const release = await h.pool.acquire();

    await expect(h.run('/doctor')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('pool-full');
  });

  it('reports policy check as access=<AccessMode> for pi profiles, not a Claude permission mode', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'pi' });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('policy check: ok access=workspace');
    expect(output).not.toContain('policy check: ok access=acceptEdits');
    expect(output).not.toContain('policy check: ok access=plan');
    expect(output).not.toContain('policy check: ok access=bypassPermissions');
  });
});

async function createHarness(options: {
  configuredWorkspace: boolean;
  bindWorkspace?: boolean;
  defaultWorkspace?: boolean;
  agentKind?: 'claude' | 'codex' | 'pi';
}): Promise<Harness> {
  const tmp = await createTmpProfile('doctor-status-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const agentKind = options.agentKind ?? 'claude';
  const profileConfig = appConfig(options.configuredWorkspace ? tmp.workspace : undefined, agentKind);
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      processPool: pool,
      runExecutor: executor,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, pool, agent, controls, run };
}

function appConfig(
  defaultWorkspace: string | undefined,
  agentKind: 'claude' | 'codex' | 'pi' = 'claude',
): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox:
      agentKind === 'pi'
        ? { defaultMode: 'workspace-write', maxMode: 'workspace-write' }
        : { defaultMode: 'read-only', maxMode: 'workspace-write' },
    ...(agentKind === 'pi' ? { pi: { binaryPath: 'pi' } } : {}),
  });
  if (defaultWorkspace) config.workspaces.default = defaultWorkspace;
  return config;
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

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdownOrText(channel: FakeChannel): string {
  const content = lastContent(channel);
  const value = content.markdown ?? content.text;
  expect(value).toBeTypeOf('string');
  return value as string;
}

function lastStreamCardJson(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  expect(stream).toBeDefined();
  const initial = (stream?.input as { card?: { initial?: unknown } } | undefined)?.card?.initial;
  return JSON.stringify(stream?.cardUpdates.at(-1) ?? initial);
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
