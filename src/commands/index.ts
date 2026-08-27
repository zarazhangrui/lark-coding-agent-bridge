import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import { DEFAULT_MODEL, normalizeModelSelection, supportedModels } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { helpCard, resumeCard, statusCard, workspacesCard } from '../card/templates';
import { setLocale, t } from '../i18n';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  getUiLanguage,
} from '../config/schema';
import type {
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
} from '../config/profile-schema';
import { effectiveLarkCliIdentity } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { accessToClaudePermissionMode } from '../config/permissions';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { buildEncryptedAccountConfig } from '../config/store';
import * as configOps from '../config/config-ops';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../session/history';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import { readUiSidecar } from '../ui/sidecar';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { describeMeetingError, type MeetingManager } from '../meeting/manager';
import { isMeetingNo } from '../meeting/api';
import { answerInMeeting, meetingScopeId } from '../meeting/orchestrator';
import type { MeetingSession } from '../meeting/session';
import { hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
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
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
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
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex';
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
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
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/meeting': handleMeeting,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  // Joining a meeting makes the bot visible to every participant and exposes
  // meeting content to the agent — owner/admin only.
  '/meeting',
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
  setLocale(getUiLanguage(ctx.controls.cfg));
  if (
    isAdminCommand(cmd) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, t('common.adminOnly'));
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
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
  setLocale(getUiLanguage(ctx.controls.cfg));
  if (
    isAdminCommand(name) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
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
    reportMetric('command_fail', 1, { step: 'handler' });
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
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    const auditSafeReply = t('common.commandProcessed');
    if (!isMessageAuditReject(err) || markdown === auditSafeReply) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: auditSafeReply },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? t('new.interruptedAndStarted') : t('new.started'));
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, t('newchat.createFailed', { msg }));
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? t('newchat.welcomeWithCwd', { cwd: sourceCwd })
    : t('newchat.welcomeNoCwd');
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(ctx, t('newchat.created', { name: created.name }));
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, t('cd.usage'));
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, t('cd.notAbsolute'));
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, t('cd.success', { cwd: workspace.cwdRealpath }));
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
    default:
      await reply(ctx, t('ws.usage'));
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, t('ws.save.usage'));
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, t('ws.save.noCwd'));
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, t('ws.save.success', { name, cwd }));
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, t('ws.use.usage'));
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, t('ws.aliasNotFound', { name }));
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, t('ws.use.success', { name, cwd: workspace.cwdRealpath }));
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, t('ws.remove.usage'));
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, t('ws.aliasNotFound', { name }));
    return;
  }
  await reply(ctx, t('ws.remove.success', { name }));
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, t('doc.hint'));
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
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

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, t('resume.needCwd'));
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, t('resume.groupNotSupported'));
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    const identity = ctx.sessionCatalogIdentity;
    const entry =
      ctx.sessionCatalog && identity
        ? ctx.sessionCatalog.activeFor(identity)
        : undefined;
    const history = identity ? await listCodexResumeHistory(ctx, cwd, limit) : [];
    if (history.length > 0 && identity) {
      const entries = history.map((thread) => {
        const nonce = issueResumeCandidate(identity, { threadId: thread.threadId });
        return {
          sessionId: nonce,
          preview: thread.name || thread.preview,
          relTime: formatRelTime(thread.updatedAtMs),
          detail: `Codex · ${thread.source}`,
          current: thread.threadId === entry?.threadId,
        };
      });
      const card = resumeCard(cwd, entries);
      await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
      return;
    }
    if (entry?.threadId && identity) {
      const nonce = issueResumeCandidate(identity, { threadId: entry.threadId });
      await reply(ctx, t('resume.codexAvailable', { nonce }));
      return;
    }
    const card = resumeCard(cwd, []);
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }

  const sessions = await listClaudeResumeHistory(ctx, cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      ctx.activeRuns.interrupt(ctx.scope);
      if (ctx.sessionCatalogIdentity.agentId === 'codex') {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'codex',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          threadId: resolved.threadId!,
        });
      } else {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'claude',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId!,
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId!, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      await reply(ctx, t('resume.applied'));
      return;
    }
    if (ctx.sessionCatalogIdentity.agentId === 'codex') {
      await reply(ctx, t('resume.codexInvalid'));
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, t('resume.claudeInvalid'));
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalogIdentity.agentId === 'claude') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, t('resume.applied'));
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    await reply(ctx, t('resume.codexNone'));
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, t('resume.needCwd'));
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, t('resume.applied'));
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    (identity.agentId === 'claude' && !candidate.sessionId) ||
    (identity.agentId === 'codex' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  if (profileConfig.agentKind === 'claude') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: 'sandbox',
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = ctx.controls.profileConfig.agentKind === 'codex';
  const catalogEntry =
    isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isCodex ? t('status.sessionEmptyCodex') : undefined,
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, t('stop.adminOnly'));
    return;
  }
  const scope = targetScope || ctx.scope;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
  });
  if (targetScope) {
    await reply(ctx, ok ? t('stop.requested', { scope }) : t('stop.notFound', { scope }));
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, t('timeout.adminOnly'));
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? t('timeout.minutes', { n: globalMinutes }) : t('timeout.notEnabled');

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage = t('timeout.usage');
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? t('timeout.minutes', { n: scopeMinutes }) : t('timeout.disabledCurrent');
      await reply(ctx, t('timeout.currentEffective', { scopeLabel, effective, global: formatGlobal(), usage }));
      return;
    }
    await reply(ctx, t('timeout.followsGlobal', { scopeLabel, global: formatGlobal(), usage }));
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? t('timeout.cleared', { global: formatGlobal() })
        : t('timeout.notOverridden', { global: formatGlobal() }),
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, t('timeout.off'));
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, t('timeout.invalidUsage'));
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, t('timeout.set', { n }));
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, t('ps.none'));
    return;
  }

  const rows: string[] = [
    t('ps.tableHeader'),
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? t('ps.currentReplying') : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    t('ps.header', { n: live.length }),
    '',
    rows.join('\n'),
    '',
    t('ps.footer', { id: ctx.controls.processId }),
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(ctx, t('exit.usage', { id: ctx.controls.processId }));
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, t('exit.notFound', { target }));
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, t('exit.self', { id: entry.id }));
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
    await reply(ctx, t('exit.otherFailed', { id: entry.id, err: (err as Error).message }));
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(ctx, t('exit.stillAlive', { id: entry.id }));
  } else {
    await reply(ctx, t('exit.otherSuccess', { id: entry.id }));
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return t('time.ago.seconds', { n: Math.floor(ms / 1000) });
  if (ms < 3_600_000) return t('time.ago.minutes', { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t('time.ago.hours', { n: Math.floor(ms / 3_600_000) });
  return t('time.ago.days', { n: Math.floor(ms / 86_400_000) });
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? t('reconnect.afterRun') : t('reconnect.now'));
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, t('reconnect.failed', { err: err instanceof Error ? err.message : String(err) }));
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, t('doctor.rateLimited'));
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: t('doctor.noWorkspace'),
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: t('doctor.workspaceUnavailable', { reason: workspace.userVisible }),
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, t('doctor.inFlight'));
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability =
    ctx.controls.profileConfig.agentKind === 'codex'
      ? codexCapability(ctx.controls.profileConfig)
      : claudeCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, t('doctor.ack'));
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
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
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? t('common.notSet')}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
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
      await reply(ctx, t('account.usage'));
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
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
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
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

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
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure(t('account.emptyFields'));
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
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(t('account.saveFailed', { msg }));
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
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, t('invite.noGroups'));
    } else {
      await reply(ctx, t('invite.allGroupsAdded', { added, total }));
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(ctx, t('invite.usage'));
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, t('invite.groupInP2p'));
      return;
    }
    const chatId = ctx.msg.chatId;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, t('invite.groupAlready'));
      return;
    }
    await reply(ctx, t('invite.groupAdded', { chatId }));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, t('invite.noMention', { kind }));
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? t('access.label.users') : t('access.label.admins');
  const sep = t('common.listSeparator');
  const parts: string[] = [];
  if (added.length > 0) parts.push(t('invite.added', { names: added.join(sep), label }));
  if (already.length > 0) parts.push(t('invite.already', { names: already.join(sep), label }));
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(ctx, t('remove.usage'));
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, t('remove.groupInP2p'));
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (missing) {
      await reply(ctx, t('remove.groupMissing'));
      return;
    }
    await reply(ctx, t('remove.groupRemoved'));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, t('remove.noMention', { kind }));
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? t('access.label.users') : t('access.label.admins');
  const sep = t('common.listSeparator');
  const parts: string[] = [];
  if (removed.length > 0) parts.push(t('remove.removed', { names: removed.join(sep), label }));
  if (notThere.length > 0) parts.push(t('remove.notThere', { names: notThere.join(sep), label }));
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  return configOps.saveAccessConfig(ctx.controls, mutate);
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
      await reply(ctx, t('config.usage'));
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  // Surface the local web console URL when the supervisor (`--web-ui`) is
  // running — read from the host sidecar and confirm the owning process is
  // alive so we don't advertise a stale address.
  const sidecar = await readUiSidecar(commandProfilePaths(ctx).hostUiFile).catch(() => undefined);
  const consoleUrl = sidecar && isAlive(sidecar.pid) ? sidecar.url : undefined;
  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    mode: ctx.controls.profileConfig.mode,
    model: normalizeModelSelection(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.cfg.preferences?.model,
    ),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelValid = rawModel !== '' && supportedModels(agentKind).some((m) => m.value === rawModel);
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
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
  // Parse deployment mode. Empty / unexpected keeps current.
  const rawMode = String(fv.deploy_mode ?? '').trim();
  const mode: ProfileMode =
    rawMode === 'team' || rawMode === 'personal'
      ? rawMode
      : ctx.controls.profileConfig.mode;
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  // Effective preset = what actually gets applied to lark-cli. Team mode forces
  // bot-only regardless of the stored identity select; the select value is still
  // saved verbatim so it comes back when switching to personal mode. Re-apply
  // the lark-cli policy whenever the *effective* preset changes (covers both a
  // direct identity-select change and a personal↔team flip).
  const nextEffectiveIdentity: LarkCliIdentityPreset =
    mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(ctx.controls.profileConfig);
  const larkCliIdentityChanged = nextEffectiveIdentity !== previousEffectiveIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

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

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, nextEffectiveIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity, mode);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousEffectiveIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousEffectiveIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      mode,
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        mode,
        model: modelSelection,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return t('config.fail.rollbackFailed');
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return t('config.fail.rolledBack');
  }
  if (step === 'config.lark-cli-policy') {
    return t('config.fail.policyNotApplied');
  }
  return t('config.fail.notWritten');
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  return configOps.applyProfileLarkCliIdentity(ctx.controls, larkCliIdentity);
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  return configOps.saveAccountConfig(ctx.controls, newCfg, plaintextSecret);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
): Promise<void> {
  return configOps.savePreferencesConfig(
    ctx.controls,
    preferences,
    requireMentionInGroup,
    larkCliIdentity,
    mode,
  );
}

// ────────────── /meeting — in-meeting agent (智能体入会) ──────────────

/**
 * `/meeting` drives the bot's presence in a Feishu video meeting: join by
 * 9-digit number, leave, inspect what the session has captured, and ask the
 * agent a question with the meeting transcript as context.
 */
async function handleMeeting(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const manager = ctx.controls.meeting;

  if (!ctx.controls.profileConfig.meeting.enabled) {
    await reply(ctx, t('meeting.notEnabled'));
    return;
  }
  if (!manager) {
    await reply(ctx, t('meeting.notReady'));
    return;
  }

  switch (sub) {
    case '':
    case 'status':
      await replyMeetingStatus(ctx, manager);
      return;
    case 'join': {
      const meetingNo = rest.replace(/\s/g, '');
      if (!isMeetingNo(meetingNo)) {
        await reply(ctx, t('meeting.join.usage'));
        return;
      }
      try {
        const session = await manager.join(meetingNo, { originChatId: ctx.msg.chatId });
        await reply(
          ctx,
          t('meeting.joined', {
            topic: session.topic ?? meetingNo,
            meetingNo: session.meetingNo,
            trigger: ctx.controls.profileConfig.meeting.trigger,
          }),
        );
      } catch (err) {
        await reply(ctx, t('meeting.joinFailed', { err: describeMeetingError(err) }));
      }
      return;
    }
    case 'leave': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      await manager.leave(picked.session.meetingId);
      await reply(ctx, t('meeting.left', { meetingNo: picked.session.meetingNo }));
      return;
    }
    case 'transcript': {
      // Shows exactly what the agent is given as context. Without this, "why
      // did it mention X?" is unanswerable — the buffer is invisible.
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const lines = picked.session.recentTranscript();
      if (lines.length === 0) {
        await reply(ctx, t('meeting.transcriptEmpty'));
        return;
      }
      const tail = lines.slice(-30);
      await reply(
        ctx,
        [
          t('meeting.transcriptHeader', {
            n: lines.length,
            suffix:
              tail.length < lines.length ? t('meeting.transcriptRecentSuffix', { m: tail.length }) : '',
          }),
          '```',
          ...tail,
          '```',
        ].join('\n'),
      );
      return;
    }
    case 'stop': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const stopped = ctx.activeRuns.interrupt(meetingScopeId(picked.session.meetingId));
      await reply(ctx, stopped ? t('meeting.stopInterrupted') : t('meeting.stopNone'));
      return;
    }
    case 'notes':
    case 'ask': {
      // `notes` takes an optional meeting number; `ask` takes the question, so
      // only `notes` can disambiguate positionally.
      const picked = pickMeetingSession(manager, ctx, sub === 'notes' ? rest : '');
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const session = picked.session;
      const question = sub === 'notes' ? t('meeting.notesPrompt') : rest;
      if (!question) {
        await reply(ctx, t('meeting.ask.usage'));
        return;
      }
      if (!ctx.runExecutor) {
        await reply(ctx, t('meeting.noExecutor'));
        return;
      }
      await reply(ctx, sub === 'notes' ? t('meeting.summarizing') : t('meeting.thinking'));
      try {
        const answer = await answerInMeeting(
          {
            session,
            channel: ctx.channel,
            controls: ctx.controls,
            executor: ctx.runExecutor,
            activeRuns: ctx.activeRuns,
            sessions: ctx.sessions,
            ...(ctx.sessionCatalog ? { sessionCatalog: ctx.sessionCatalog } : {}),
            workspaces: ctx.workspaces,
          },
          question,
          // Typed privately -> answer only to the caller. Broadcasting a
          // summary somebody asked for in a DM would surprise the meeting.
          { deliver: 'caller' },
        );
        await reply(ctx, answer || t('meeting.noAnswer'));
      } catch (err) {
        await reply(ctx, t('meeting.execFailed', { err: describeMeetingError(err) }));
      }
      return;
    }
    default:
      await reply(ctx, t('meeting.usage'));
  }
}

type PickedSession =
  | { ok: true; session: MeetingSession }
  | { ok: false; message: string };

/**
 * Resolve which meeting a command targets when the bot may be in several.
 *
 * Order: explicit 9-digit number → the only meeting → the only meeting joined
 * from *this* chat → otherwise ask, listing the candidates. Silently defaulting
 * to "the first one" would act on the wrong meeting.
 */
function pickMeetingSession(
  manager: MeetingManager,
  ctx: CommandContext,
  explicit: string,
): PickedSession {
  const wanted = explicit.replace(/\s/g, '');
  if (wanted) {
    const found = manager.byMeetingNo(wanted);
    return found
      ? { ok: true, session: found }
      : { ok: false, message: t('meeting.pick.notFound', { wanted }) };
  }

  const all = manager.all();
  if (all.length === 0) {
    return { ok: false, message: t('meeting.pick.none') };
  }
  if (all.length === 1) return { ok: true, session: all[0]! };

  // Multiple meetings: prefer the one started from this chat.
  const fromHere = all.filter((s) => s.originChatId === ctx.msg.chatId);
  if (fromHere.length === 1) return { ok: true, session: fromHere[0]! };

  const list = all.map((s) => `- ${s.meetingNo}${s.topic ? `（${s.topic}）` : ''}`).join('\n');
  return {
    ok: false,
    message: t('meeting.pick.multiple', { n: all.length, list, example: all[0]!.meetingNo }),
  };
}

async function replyMeetingStatus(ctx: CommandContext, manager: MeetingManager): Promise<void> {
  const sessions = manager.list();
  const push = manager.pushHealth();
  const pushLine = push.hooked
    ? t('meeting.push.hooked', {
        n: push.received,
        suffix: push.received === 0 ? t('meeting.push.noneReceivedSuffix') : '',
      })
    : t('meeting.push.notHooked', { reason: push.reason ?? t('meeting.push.unknownReason') });

  if (sessions.length === 0) {
    await reply(ctx, [t('meeting.status.noneHeader'), pushLine, '', t('meeting.status.joinHint')].join('\n'));
    return;
  }
  const lines = sessions.map((s) =>
    t('meeting.status.line', {
      topic: s.topic ?? s.meetingNo,
      meetingNo: s.meetingNo,
      source: s.source === 'push' ? t('meeting.source.push') : t('meeting.source.poll'),
      lines: s.transcriptLines,
      participants: s.participants,
    }),
  );
  await reply(ctx, [t('meeting.status.header', { n: sessions.length }), ...lines, '', pushLine].join('\n'));
}
