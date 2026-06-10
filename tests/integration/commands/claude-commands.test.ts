import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent, type FakeAgentRun } from '../../helpers/fake-agent.js';
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
  cleanup(): Promise<void>;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Claude slash command visible behavior', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lets unknown slash commands fall through as ordinary agent messages', async () => {
    const h = await createHarness();

    await expect(h.run('/xxx keep this as a prompt')).resolves.toBe(false);
    expect(h.channel.sent).toEqual([]);
  });

  it('handles /new and /reset by clearing session state', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'old-session', h.tmp.workspace);

    await expect(h.run('/new')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toBe('已开始新会话。');
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();

    h.sessions.set('chat-1', 'old-session-2', h.tmp.workspace);
    await expect(h.run('/reset')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toBe('已开始新会话。');
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
  });

  it('keeps the per-scope timeout override when /new clears the resumable session', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'old-session', h.tmp.workspace);
    h.sessions.setIdleTimeoutMinutes('chat-1', 15);

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.sessions.resumeFor('chat-1', h.tmp.workspace)).toBeUndefined();
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBe(15);
  });

  it('handles /cd by requiring absolute paths and resetting session on success', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'old-session', '/old');

    await expect(h.run('/cd relative')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('请使用绝对路径');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    const workspaceRealpath = await realpath(h.tmp.workspace);
    expect(lastMarkdown(h.channel)).toContain(`已切换 cwd 到 \`${workspaceRealpath}\``);
    expect(h.workspaces.cwdFor('chat-1')).toBe(workspaceRealpath);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
  });

  it('handles /ws list, save, use, and remove', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    await expect(h.run('/ws')).resolves.toBe(true);
    expect(lastContent(h.channel)).toHaveProperty('card');

    await expect(h.run('/ws save main')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');

    h.workspaces.setCwd('chat-1', '/other');
    await expect(h.run('/ws use main')).resolves.toBe(true);
    await expect(realpath(h.tmp.workspace)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
    expect(lastMarkdown(h.channel)).toContain('已切换到 `main`');

    await expect(h.run('/ws remove main')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
  });

  it('revalidates saved workspaces before switching to them', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    await expect(h.run('/ws save main')).resolves.toBe(true);
    const key = Object.keys(h.workspaces.listNamed())[0]!;
    h.workspaces.saveNamed(key, tmpdir());

    await expect(h.run('/ws use main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('不能把临时目录根设为工作目录');
    expect(h.workspaces.cwdFor('chat-1')).toBe(h.tmp.workspace);
  });

  it('saves the profile default workspace when the chat has no explicit cwd', async () => {
    const h = await createHarness();
    h.controls.profileConfig.workspaces.default = h.tmp.workspace;

    await expect(h.run('/ws save main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');
    expect(lastMarkdown(h.channel)).toContain(h.tmp.workspace);
  });

  it('handles /resume use by pinning the requested session', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    await expect(h.run('/resume use sess-1234567890')).resolves.toBe(true);

    expect(h.sessions.resumeFor('chat-1', h.tmp.workspace)).toBe('sess-1234567890');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('handles /status and /help with cards', async () => {
    const h = await createHarness();
    await writeLarkCliTarget(h, {
      defaultAs: 'auto',
      strictMode: 'off',
      users: [{ openId: 'ou-user' }],
    });

    await expect(h.run('/status')).resolves.toBe(true);
    expect(lastContent(h.channel)).toHaveProperty('card');
    expect(JSON.stringify(lastContent(h.channel))).toContain('lark-cli');
    expect(JSON.stringify(lastContent(h.channel))).toContain('user-ready');

    await expect(h.run('/help')).resolves.toBe(true);
    expect(lastContent(h.channel)).toHaveProperty('card');
    const help = JSON.stringify(lastContent(h.channel));
    expect(help).toContain('Fake Agent');
    expect(help).toContain('lark-cli 身份策略');
    expect(help).not.toContain('/lark');
    expect(help).not.toContain('交给 Claude');
  });

  it('reports lark-cli user-ready for structured user records', async () => {
    const h = await createHarness();
    await writeLarkCliTarget(h, {
      defaultAs: 'auto',
      strictMode: 'off',
      users: { current: { userOpenId: 'ou-user', userName: 'User Name' } },
    });

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('lark-cli');
    expect(status).toContain('user-ready');
    expect(status).not.toContain('user-missing');
  });

  it('does not report lark-cli user-ready for display-only target user strings', async () => {
    const h = await createHarness();
    h.controls.profileConfig.larkCli = { identityPreset: 'user-default' };
    await writeLarkCliTarget(h, {
      defaultAs: 'auto',
      strictMode: 'off',
      users: 'User Name (ou-user)',
    });

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('lark-cli');
    expect(status).toContain('user-missing');
    expect(status).not.toContain('user-ready');
  });

  it('does not report lark-cli user-ready for damaged structured user entries', async () => {
    const h = await createHarness();
    h.controls.profileConfig.larkCli = { identityPreset: 'user-default' };
    await writeLarkCliTarget(h, {
      defaultAs: 'auto',
      strictMode: 'off',
      users: [{ userName: 'User Name' }],
    });

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('lark-cli');
    expect(status).toContain('user-missing');
    expect(status).not.toContain('user-ready');
  });

  it('does not report lark-cli user-ready when the profile is user-default but no user is authorized', async () => {
    const h = await createHarness();
    h.controls.profileConfig.larkCli = { identityPreset: 'user-default' };

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('lark-cli');
    expect(status).toContain('user-missing');
    expect(status).not.toContain('user-ready');
  });

  it('does not treat lark-cli display-only no-user text as authorized user state', async () => {
    const h = await createHarness();
    h.controls.profileConfig.larkCli = { identityPreset: 'user-default' };
    await writeLarkCliTarget(h, {
      defaultAs: 'auto',
      strictMode: 'off',
      users: '(no logged-in users)',
    });

    await expect(h.run('/status')).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('lark-cli');
    expect(status).toContain('user-missing');
    expect(status).not.toContain('user-ready');
  });

  it('handles /timeout display, set, off, default, and invalid values', async () => {
    const h = await createHarness();

    await expect(h.run('/timeout')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('当前 session 探活');

    await expect(h.run('/timeout 15')).resolves.toBe(true);
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBe(15);
    expect(lastMarkdown(h.channel)).toContain('已设为 15 分钟');

    await expect(h.run('/timeout off')).resolves.toBe(true);
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBe(0);
    expect(lastMarkdown(h.channel)).toContain('已关闭当前 session');

    await expect(h.run('/timeout default')).resolves.toBe(true);
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已清除 session 覆盖');

    await expect(h.run('/timeout 999')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法:`/timeout <1-120>`');
  });

  it('handles /stop without sending a new reply', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);

    await expect(h.run('/stop')).resolves.toBe(true);

    expect(h.channel.sent).toEqual([]);
    expect(activeRun.stopped).toBe(true);
  });

  it('lets admins stop and configure comment scopes explicitly', async () => {
    const h = await createHarness();
    const commentScope = 'comment:abc123';
    const activeRun = h.agent.run({ runId: 'run-comment', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register(commentScope, activeRun);

    await expect(h.run(`/stop ${commentScope}`)).resolves.toBe(true);
    expect(activeRun.stopped).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已请求停止');

    await expect(h.run(`/timeout ${commentScope} 2`)).resolves.toBe(true);
    expect(h.sessions.getIdleTimeoutMinutes(commentScope)).toBe(2);
    expect(lastMarkdown(h.channel)).toContain('已设为 2 分钟');
  });

  it('surfaces active comment scopes in /status for targeted controls', async () => {
    const h = await createHarness();
    const commentScope = 'comment:abc123';
    const activeRun = h.agent.run({ runId: 'run-comment', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register(commentScope, activeRun);

    await expect(h.run('/status')).resolves.toBe(true);

    expect(JSON.stringify(lastContent(h.channel))).toContain(commentScope);
  });

  it('handles /ps and /exit help text', async () => {
    const h = await createHarness();

    await expect(h.run('/ps')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toMatch(/当前(有 .* 个 bot|没有 bot)/);

    await expect(h.run('/exit')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法:`/exit <id|#>`');
  });

  it('handles /reconnect by acknowledging then calling restart', async () => {
    const h = await createHarness();

    await expect(h.run('/reconnect')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toBe('⏳ 正在停止当前运行并重连…');
    expect(h.controls.restart).toHaveBeenCalledTimes(1);
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('claude-commands-test-');

  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = appConfig(tmp.workspace);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

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
      controls,
    });

  const cleanup = async (): Promise<void> => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  };
  cleanups.push(cleanup);

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, cleanup, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
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

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}

async function writeLarkCliTarget(
  h: Harness,
  app: {
    defaultAs: string;
    strictMode: string;
    users: unknown;
  },
): Promise<void> {
  const target = join(
    h.tmp.profile,
    'profiles',
    h.controls.profile,
    'lark-cli',
    'lark-channel',
    'config.json',
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify({
      apps: [
        {
          appId: h.controls.profileConfig.accounts.app.id,
          brand: h.controls.profileConfig.accounts.app.tenant,
          defaultAs: app.defaultAs,
          strictMode: app.strictMode,
          users: app.users,
        },
      ],
    }),
    'utf8',
  );
}
