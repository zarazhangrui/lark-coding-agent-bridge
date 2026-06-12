import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
  mentions?: NormalizedMessage['mentions'];
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Bridge command contracts', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('switches /cd to any existing non-risk working directory', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'plain-workdir');
    const file = join(h.tmp.workspace, 'not-a-directory.txt');
    await mkdir(target, { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run('/cd relative')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绝对路径');

    await expect(h.run(`/cd ${file}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('路径不是目录');

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');
    await expect(realpath(target)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    await expect(realpath(h.tmp.workspace)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('scopes named workspaces by profile, scope, and owner', async () => {
    const h = await createHarness();
    const alternate = join(h.tmp.root, 'alternate');
    await mkdir(alternate, { recursive: true });

    h.workspaces.setCwd('chat-a', h.tmp.workspace);
    await expect(h.run('/ws save main', { scope: 'chat-a', chatId: 'chat-a' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');

    h.workspaces.setCwd('chat-b', alternate);
    await expect(h.run('/ws', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('main');

    await expect(h.run('/ws use main', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
    expect(h.workspaces.cwdFor('chat-b')).toBe(alternate);
  });

  it('continues to support legacy unscoped workspace aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-alias');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('legacy', legacy);

    await expect(h.run('/ws')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('legacy');

    await expect(h.run('/ws use legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `legacy`');
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run('/ws remove legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('legacy')).toBeUndefined();
  });

  it('removes scoped workspace aliases without deleting same-name legacy aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-main');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('main', legacy);

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('main')).toBe(legacy);

    await expect(h.run('/ws use main')).resolves.toBe(true);
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('keeps directory commands admin-only', async () => {
    const h = await createHarness();

    await expect(h.run(`/cd ${h.tmp.workspace}`, { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    await expect(h.run('/ws save mine', { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose authorization root management commands', async () => {
    const h = await createHarness();
    const plain = join(h.tmp.root, 'plain-nongit');
    await mkdir(plain, { recursive: true });

    await expect(h.run(`/ws add ${plain} docs`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');

    await expect(h.run(`/ws remove --root ${plain}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
  });

  it('keeps /ws remove as alias removal by default', async () => {
    const h = await createHarness();

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
  });

  it('shows workspace paths in group-visible workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-client-name');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    await expect(h.run('/ws save client', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('client');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws', { chatMode: 'group' })).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
    expect(card).not.toContain('使用 $HOME');

    await expect(h.run('/ws use main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `main`');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);
  });

  it('shows full workspace paths in p2p workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-p2p-client');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save client')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
  });

  it('shows invalid /cd paths in group-visible replies', async () => {
    const h = await createHarness();
    const file = join(h.tmp.root, 'sensitive-client-name', 'not-a-directory.txt');
    await mkdir(join(h.tmp.root, 'sensitive-client-name'), { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run(`/cd ${file}`, { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('路径不是目录');
    expect(lastMarkdown(h.channel)).toContain(await realpath(file));
  });

  it('treats legacy document workspace commands as informational no-ops', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-doc-root');
    await mkdir(target, { recursive: true });

    await expect(h.run(`/doc ws bind doc-token ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不需要绑定工作区');
    expect(lastMarkdown(h.channel)).not.toContain(target);
  });

  it('keeps Claude resume history details out of group chats', async () => {
    const h = await createHarness();

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('私聊');
    expect(lastMarkdown(h.channel)).not.toContain(h.tmp.workspace);
  });

  it('renders /status passively with policy and owner state', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('Fake Agent');
    expect(status).toContain('工作目录');
    expect(status).toContain('**session**');
    expect(status).toContain('(无)');
    expect(status).not.toContain('**conversation**');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
    expect(status).not.toContain('workspace-write/workspace-write');
    expect(status).toContain('owner');
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
  });

  it('shows workspace paths in group-visible /status replies', async () => {
    const h = await createHarness();

    await expect(h.run('/status', { chatMode: 'group' })).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
    expect(status).toContain('chat-1');
  });

  it('rejects admin-only commands for non owner/admin users', async () => {
    const h = await createHarness();

    await expect(
      h.run('/ps', { senderId: 'ou-not-admin' }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose access allowlists through the Lark /config form', async () => {
    const h = await createHarness();

    await expect(h.run('/config')).resolves.toBe(true);

    const configCard = JSON.stringify(lastContent(h.channel));
    expect(configCard).not.toContain('allowed_users');
    expect(configCard).not.toContain('allowed_chats');
    expect(configCard).not.toContain('admins');
  });

  it('manages profile access lists through /invite and /remove', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).toContain('ou-alice');
    expect(root?.profiles.claude?.access.admins).toEqual(['ou-admin', 'ou-bob']);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.preferences).not.toHaveProperty('access');

    await expect(
      h.run('/remove user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).not.toContain('ou-alice');
  });

  it('adds every known bot group through /invite all group', async () => {
    const h = await createHarness();
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toEqual(['oc-group-1', 'oc-group-2']);
  });

  // ── /botAdmin command tests ──

  it('adds and removes bot admins through /botAdmin add/remove', async () => {
    const h = await createHarness();

    // Add bot admin
    await expect(
      h.run('/botAdmin add @Bot', { mentions: [botMention('ou-bot', 'Bot')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已把 Bot 加入 Bot 管理员');

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toContain('ou-bot');

    // Add same bot again (idempotent)
    await expect(
      h.run('/botAdmin add @Bot', { mentions: [botMention('ou-bot', 'Bot')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已经在 Bot 管理员里');

    // List
    await expect(h.run('/botAdmin list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('ou-bot');

    // Remove
    await expect(
      h.run('/botAdmin remove @Bot', { mentions: [botMention('ou-bot', 'Bot')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('移出 Bot 管理员');

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).not.toContain('ou-bot');
  });

  it('shows empty list for /botAdmin list when no bot admins', async () => {
    const h = await createHarness();
    await expect(h.run('/botAdmin list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('无 Bot 管理员');
  });

  it('requires @-mention for /botAdmin add and /botAdmin remove', async () => {
    const h = await createHarness();
    // No mentions at all
    await expect(h.run('/botAdmin add')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 @ 的 Bot');
    // Human mention (not bot)
    await expect(
      h.run('/botAdmin add @User', { mentions: [mention('ou-user', 'User')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 @ 的 Bot');
  });

  // ── botAdmin permission split tests ──

  it('allows botAdmin to run operational commands', async () => {
    const h = await createHarness();
    // Make the sender a botAdmin
    const access = h.controls.profileConfig.access;
    access.botAdmins = ['ou-bot'];
    await saveRootConfig(
      createRootConfig('claude', h.controls.profileConfig),
      h.controls.configPath,
    );

    const botRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-bot', ...overrides });

    // Allowed: operational commands
    await expect(botRun('/cd /tmp')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).not.toContain('仅管理员可用');

    await expect(botRun('/invite group', { chatId: 'oc-g', scope: 'oc-g', chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已把当前群');

    await expect(botRun('/status')).resolves.toBe(true);
    await expect(botRun('/help')).resolves.toBe(true);
  });

  it('rejects botAdmin from role-elevation commands', async () => {
    const h = await createHarness();
    const access = h.controls.profileConfig.access;
    access.botAdmins = ['ou-bot'];
    await saveRootConfig(
      createRootConfig('claude', h.controls.profileConfig),
      h.controls.configPath,
    );

    const botRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-bot', ...overrides });

    // Denied: /invite admin (role elevation — handler-level gate)
    await expect(
      botRun('/invite admin @User', { mentions: [mention('ou-user', 'User')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Bot 管理员只能使用');

    // Denied: /botAdmin add (managing botAdmins)
    await expect(
      botRun('/botAdmin add @Bot2', { mentions: [botMention('ou-bot2', 'Bot2')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    // Denied: /config (sensitive)
    await expect(botRun('/config')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    // Denied: /account (credential)
    await expect(botRun('/account')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('allows regular allowed users to run public self-service commands', async () => {
    const h = await createHarness();
    const userRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-user', ...overrides });

    await expect(userRun('/help')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/new')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已开始新会话');

    h.activeRuns.register('chat-1', h.agent.run({ runId: 'run-1', prompt: 'running' }));
    await expect(userRun('/stop')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/config')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  // ── Anti-lockout tests ──

  it('prevents removing the last human admin', async () => {
    const h = await createHarness();
    // Only one admin exists: 'ou-admin' (set by appConfig)
    await expect(
      h.run('/remove admin @Admin', { mentions: [mention('ou-admin', 'Admin')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不能移除最后一位管理员');

    // Verify admin was NOT removed
    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.admins).toContain('ou-admin');
  });

  it('allows removing an admin when another admin remains', async () => {
    const h = await createHarness();
    // Add a second admin first
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);

    // Now remove the original admin
    await expect(
      h.run('/remove admin @Admin', { mentions: [mention('ou-admin', 'Admin')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('移出管理员');

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.admins).not.toContain('ou-admin');
    expect(root?.profiles.claude?.access.admins).toContain('ou-bob');
  });

  // ── Text-forgery rejection test ──

  it('does not accept text @ as structured mention for access gating', async () => {
    const h = await createHarness();
    // Send /invite user with text "@user" but NO structured mention
    // The handler should reject because mentionTargets() uses msg.mentions only
    await expect(
      h.run('/invite user @Someone'),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 @ 的用户');
  });

  // ── /project start tests ──

  it('starts a project workspace with structured receipt', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'my-project');
    await mkdir(target, { recursive: true });

    await expect(h.run(`/project start ${target}`)).resolves.toBe(true);
    const text = lastMarkdown(h.channel);
    expect(text).toContain('项目工作区启动完成');
    expect(text).toContain('路径校验');
    expect(text).toContain('工作目录切换');
    expect(text).toContain('Session 重置');
  });

  it('rejects /project start with invalid path', async () => {
    const h = await createHarness();
    await expect(h.run('/project start /nonexistent/path')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('路径校验失败');
  });

  it('rejects /project start with relative path', async () => {
    const h = await createHarness();
    await expect(h.run('/project start relative/path')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绝对路径');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('commands-v1-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
        mentions: overrides.mentions ?? [],
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
    mentions?: NormalizedMessage['mentions'];
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: opts.mentions ?? [],
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

function botMention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: true,
  } as NonNullable<NormalizedMessage['mentions']>[number];
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

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
