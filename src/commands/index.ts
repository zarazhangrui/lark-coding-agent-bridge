import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import { configCancelledCard, configFormCard, configSavedCard } from '../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  helpCard,
  resumeCard,
  statusCard,
  workspacesCard,
  wsBoundCard,
  wsBrowseCard,
  wsCreateCancelledCard,
  wsCreateFormCard,
  wsCreatedCard,
} from '../card/templates';
import type { AppConfig, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  secretKeyForApp,
} from '../config/schema';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, readRecentLogs, sanitizeLogsForDoctor } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions } from '../session/history';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { sendAndPinMenu } from '../bot/menu';

export interface Controls {
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  controls: Controls;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/menu': handleMenu,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated on the configured admin allowlist;
 * empty list = no restriction (every allowed user can run them — see
 * `isAdmin` in config/schema).
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope);
  const name = rawName || defaultChatName();

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!input.startsWith('/') && !input.startsWith('~')) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    case 'new':
      return showWsBrowse('new', homedir(), ctx);
    case 'add':
      return showWsBrowse('add', homedir(), ctx);
    case 'browseNew':
      return showWsBrowse('new', name || homedir(), ctx, true);
    case 'browseAdd':
      return showWsBrowse('add', name || homedir(), ctx, true);
    case 'newat':
      return showWsCreateForm(name || homedir(), ctx);
    case 'bind':
      return bindExisting(name, ctx);
    case 'create':
      return submitWsCreate(name, ctx);
    case 'cancel':
      return cancelWsCreate(ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>|new|add]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = ctx.workspaces.listNamed();
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope);
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(name, cwd);
  await reply(ctx, `✓ 工作空间已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = ctx.workspaces.getNamed(name);
  if (!cwd) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${cwd})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!ctx.workspaces.removeNamed(name)) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作空间：\`${name}\``);
}

/**
 * Render the directory browser for `dir`. `isDrill` is true when navigating
 * within the browser (up/into a subdir), false when first opening it from the
 * menu.
 *
 * Navigation updates the same card so the chat doesn't fill with cards. The
 * managed-card registry that enables in-place updates is in-memory, so it's
 * empty for cards from a previous process (e.g. after a restart). To stay
 * robust we update in place when the card is live, and otherwise recall the
 * stale browser card and send a fresh one — never stacking duplicates. The
 * first open (from the menu) always sends a new card and leaves the menu put.
 */
async function showWsBrowse(
  mode: 'add' | 'new',
  dir: string,
  ctx: CommandContext,
  isDrill = false,
): Promise<void> {
  const abs = expandTilde(dir);
  let subdirs: string[];
  let truncated: boolean;
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    const all = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const CAP = 30;
    subdirs = all.slice(0, CAP);
    truncated = all.length > CAP;
  } catch (err) {
    await reply(ctx, `❌ 无法读取目录：\`${abs}\`\n${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const card = wsBrowseCard(mode, abs, dirname(abs), subdirs, truncated);
  // Navigate by replacing the current browser card (recall + resend) so the
  // chat doesn't fill with stacked cards. The first open (from the menu) just
  // sends a new card and leaves the menu in place.
  if (ctx.fromCardAction && isDrill) await recallMessage(ctx, ctx.msg.messageId);
  await ctx.channel.send(ctx.msg.chatId, { card });
}

/** Bind an existing directory as a named workspace (named after its folder)
 * and switch to it. Triggered by "✅ 添加此目录" in the browser. */
async function bindExisting(dir: string, ctx: CommandContext): Promise<void> {
  const abs = expandTilde((dir || '').trim());
  if (!abs.startsWith('/')) {
    await reply(ctx, '❌ 路径无效。');
    return;
  }
  try {
    const st = await stat(abs);
    if (!st.isDirectory()) {
      await reply(ctx, `❌ 不是目录：\`${abs}\``);
      return;
    }
  } catch {
    await reply(ctx, `❌ 目录不存在：\`${abs}\``);
    return;
  }
  const name = basename(abs);
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.saveNamed(name, abs);
  ctx.workspaces.setCwd(ctx.scope, abs);
  ctx.sessions.clear(ctx.scope);
  log.info('command', 'ws-bind', { name, scope: ctx.scope });
  // Replace the browser card with a confirmation.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, wsBoundCard(name, abs));
}

/** Show the project-name form. The parent dir (already chosen via the browser)
 * is carried on the submit button's value. Triggered by "➕ 在此新建项目". */
async function showWsCreateForm(parent: string, ctx: CommandContext): Promise<void> {
  const card = wsCreateFormCard(expandTilde(parent));
  // Replace the browser card with the name form.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

/** Handle the name-form submit: create `<parent>/<name>`, save it as a named
 * workspace, and switch to it. `parentArg` is the browsed parent dir. */
async function submitWsCreate(parentArg: string, ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const name = String(fv.project_name ?? '').trim();
  if (!name) {
    await reply(ctx, '❌ 请填项目名。');
    return;
  }
  if (/[/\\]/.test(name) || name === '.' || name === '..') {
    await reply(ctx, '❌ 项目名不能包含 `/` `\\` 或为 `.`/`..`，它只是文件夹名。');
    return;
  }
  const parent = expandTilde((parentArg || '').trim() || homedir());
  if (!parent.startsWith('/')) {
    await reply(ctx, '❌ 父目录无效。');
    return;
  }
  const target = join(parent, name);

  // An existing directory is reused (just bind it); a non-dir collision errors.
  try {
    const st = await stat(target);
    if (!st.isDirectory()) {
      await reply(ctx, `❌ 已存在同名文件（非目录）：\`${target}\``);
      return;
    }
  } catch {
    try {
      await mkdir(target, { recursive: true });
    } catch (err) {
      await reply(ctx, `❌ 创建目录失败：\`${target}\`\n${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.saveNamed(name, target);
  ctx.workspaces.setCwd(ctx.scope, target);
  ctx.sessions.clear(ctx.scope);
  log.info('command', 'ws-create', { name, scope: ctx.scope });

  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, wsCreatedCard(name, target)).catch((err) =>
        log.warn('command', 'ws-create-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  } else {
    await reply(ctx, `✓ 新建项目 \`${name}\` → ${target}\n（已切换并存为工作空间，session 已重置）`);
  }
}

async function cancelWsCreate(ctx: CommandContext): Promise<void> {
  if (!ctx.fromCardAction) return;
  const formMsgId = ctx.msg.messageId;
  void (async () => {
    await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
    await updateManagedCard(ctx.channel, formMsgId, wsCreateCancelledCard()).catch((err) =>
      log.warn('command', 'ws-cancel-update-failed', { err: String(err) }),
    );
    forgetManagedCard(formMsgId);
  })();
}

/** `/menu` — (re)post the project-console card and pin it to the top, so the
 * switch/new-project buttons stay one tap away. Mirrors the auto-pin that
 * fires when the bot is added to a chat. */
async function handleMenu(_args: string, ctx: CommandContext): Promise<void> {
  await sendAndPinMenu(
    ctx.channel,
    ctx.workspaces.cwdFor(ctx.scope),
    ctx.workspaces.listNamed(),
    ctx.msg.chatId,
  );
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sessions = await listRecentSessions(cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const entries = sessions.map((s) => ({
    sessionId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(
    ctx,
    `✓ 已恢复会话 \`${sessionId.slice(0, 8)}…\`。接着发消息就行。`,
  );
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  // No reply: if there was a run, its in-flight render loop will mark the
  // card as 'interrupted' and re-render (`_⏹ 已被中断_`).
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

const DOCTOR_INSTRUCTIONS = `你是 lark-channel-bridge 的诊断助理。下面会给你两段输入:
1. 用户的故障描述
2. 最近的运行日志(JSON line 格式,旧→新)

日志字段含义:
- ts: ISO 时间戳
- level: info | warn | error
- phase: 模块阶段。常见值: ws(WebSocket), intake(消息入站), queue(去抖队列), flush(批处理), media(附件下载), prompt(prompt 组装), session(会话), agent(claude 子进程), card(卡片渲染), comment(文档评论), cardAction(卡片回调), command(斜杠命令), sdk(飞书 SDK 内部)
- event: enter | exit | transition | fail | 各 phase 自定义事件
- traceId: 同一逻辑操作的串联 ID(同一条消息的多个日志会共享)
- chatId: 飞书聊天 ID(用 chatId 反查相关日志)

回复严格三段,markdown 标题用二级:

## 可能原因
1-3 条最有可能的原因,每条带具体日志的时间戳或 traceId 引用。

## 关键日志片段
3-5 条最重要的日志,直接贴 JSON 行原文,后跟一行说明为什么重要。

## 建议下一步
1-3 条具体可执行的动作(检查 X / 重启 Y / 等待 Z 之类)。

如果日志里没有任何相关线索,直接说"日志不足以判断,建议:"再列动作。回复要直接,不寒暄。`;

function buildDoctorPrompt(description: string, logs: string): string {
  const desc = description.trim() || '(用户没写描述,自行从日志找最显眼的异常。)';
  return `${DOCTOR_INSTRUCTIONS}

---

用户故障描述:
${desc}

最近的运行日志:
\`\`\`
${logs}
\`\`\``;
}

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });
  // Killing any in-flight run on this chat — /doctor is a "I'm stuck" call.
  ctx.activeRuns.interrupt(ctx.scope);

  const rawLogs = await readRecentLogs({ maxBytes: 60_000 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: '没有找到日志文件 — bridge 可能刚启动或日志目录不可写。' },
      { replyTo: ctx.msg.messageId },
    );
    return;
  }
  // Scrub identifying / credential material before the logs (a) reach
  // Anthropic via the agent prompt, and (b) end up in any card payload
  // Lark may cache server-side.
  const logs = sanitizeLogsForDoctor(rawLogs);

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  const prompt = buildDoctorPrompt(args, logs);
  const run = ctx.agent.run({
    prompt,
    cwd: homedir(),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              const flush = (): Promise<void> => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  if (evt.costUsd !== undefined) {
                    log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          if (evt.costUsd !== undefined) {
            log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(state)),
        },
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    let newCfg: AppConfig;
    try {
      newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
      );
      await setSecret(secretKeyForApp(appId), appSecret);
      await saveConfig(newCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(', '),
    allowedChats: (access.allowedChats ?? []).join(', '),
    admins: (access.admins ?? []).join(', '),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch((err) =>
        log.warn('command', 'config-cancel-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : 'card';
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);

  // Parse access lists. Comma-separated; trim each, drop empties, dedupe.
  // Empty list = unrestricted (back-compat).
  const parseList = (raw: unknown): string[] => {
    return [...new Set(
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);

  // Self-lockout guard: if the submitter sets a non-empty admins list that
  // doesn't include themselves, they immediately lose the ability to reopen
  // /config. Refuse the submit and tell them what's wrong.
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'admins',
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的管理员列表,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会立即把你自己锁出 /config。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Symmetrical guard for chat allowlist: if the submitter restricts chats
  // but the chat they're currently in isn't on the list, every message
  // (including the next /config) is silently dropped at intake. Common
  // mistake: filling in *another* chat's id and forgetting the current one.
  //
  // Skipped for p2p: `allowedChats` is group-only (see intakeMessage), so
  // submitting from a DM never locks the submitter out regardless of the
  // chat list contents. Using `chatMode` not `msg.chatType` because card
  // submissions arrive with a synthesized msg that always has chatType='p2p'.
  if (
    ctx.chatMode !== 'p2p' &&
    allowedChats.length > 0 &&
    !allowedChats.includes(ctx.msg.chatId)
  ) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'chats',
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的群白名单,但其中不包含当前会话的 chat_id (\`${ctx.msg.chatId}\`)。提交后这个会话的消息会被 intake 静默丢弃,bot 不再响应。要么把当前 chat_id 加进白名单,要么清空"群白名单"留待空(=所有会话都响应)。`,
    );
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // In-place mutation — the cfg object is shared by reference with
    // runAgentBatch's reads, so this takes effect on the next message.
    ctx.controls.cfg.preferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      // Empty arrays serialize fine but read identically to omitted ones
      // (isUserAllowed / isAdmin both treat length===0 as unrestricted).
      access: { allowedUsers, allowedChats, admins },
    };

    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {});
      forgetManagedCard(formMsgId);
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length,
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
      }),
    ).catch((err) =>
      log.warn('command', 'config-save-update-failed', { err: String(err) }),
    );
    forgetManagedCard(formMsgId);
  })();
}
