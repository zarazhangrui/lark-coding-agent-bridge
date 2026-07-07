import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommentEvent, LarkChannel } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { getAgentStopGraceMs } from '../config/schema';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import { RunRejected } from '../runtime/errors';
import type { ActiveRuns } from './active-runs';
import { recordRunSessionEvent } from './run-flow';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import {
  commentDocumentScopeId,
  commentScopeId,
  commentTokenDigest,
  resolveCommentTarget,
  type ResolvedCommentTarget,
} from './comment-resource';

export { commentDocumentScopeId, commentScopeId } from './comment-resource';

export interface CommentDeps {
  channel: LarkChannel;
  evt: CommentEvent;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns?: ActiveRuns;
  executor: RunExecutor;
  controls: Controls;
}

// File types supported by drive.v1.fileComment.get; other types (slides,
// bitable, mindnote) use different APIs and are out of scope for now.
const REPLY_MAX_CHARS = 2000;
const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'file']);
const activeCommentAgentSessionRuns = new Map<string, number>();

export interface ReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}
export interface CommentReply {
  reply_id?: string;
  content?: { elements?: ReplyContentElement[] };
}

export interface CommentContext {
  question: string;
  quote?: string;
  isWhole: boolean;
  /** The reply_id of the reply that contains the @bot mention — the anchor
   * we react on. Undefined when we couldn't pinpoint a reply (top-level
   * comment with no replies fetched, etc.). */
  targetReplyId?: string;
  /** Text of the replies in this comment thread that came before the @bot
   * reply, chronological. Feishu delivers the whole thread but the bot is only
   * @-ed on one reply; without these it can't see what the thread is about (a
   * bare "说说你的思考" points at a discussion it would otherwise never see). */
  priorReplies: string[];
}

export interface ExtractCommentQuestionInput {
  replyId?: string;
  replies: CommentReply[];
}

export interface ExtractCommentQuestionResult {
  question: string;
  targetReplyId?: string;
}

/**
 * Handle a `comment` event: when the bot is @-mentioned in a cloud-doc
 * comment, fetch the comment text, run the agent, and post the answer as
 * a reply in the same comment thread.
 */
export async function handleCommentMention(deps: CommentDeps): Promise<void> {
  const { channel, evt, sessions, sessionCatalog, workspaces, controls } = deps;
  const eventDocScopeId = commentDocumentScopeId(evt.fileToken);
  const eventCommentScopeId = commentScopeId(evt.fileToken, evt.commentId);
  // Log every comment event we receive, regardless of whether we'll act on it.
  // `mentionedBot` and `replyId` here let us tell apart top-level comments
  // from thread replies (the latter requires SDK ≥ 1.65.0-alpha.0).
  log.info('comment', 'enter', {
    docScopeId: eventDocScopeId,
    fileType: evt.fileType,
    commentScopeId: eventCommentScopeId,
    replyDigest: evt.replyId ? commentTokenDigest(evt.replyId) : undefined,
    mentionedBot: evt.mentionedBot,
    sender: evt.operator.openId,
  });
  if (!evt.mentionedBot) {
    log.info('comment', 'skip', { reason: 'not-mentioned' });
    return;
  }
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
    log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
    return;
  }
  if (isBridgeSelfReply(channel, evt)) {
    log.info('comment', 'skip', {
      reason: 'bridge-self-reply',
      commentScopeId: eventCommentScopeId,
    });
    return;
  }
  const target = await resolveCommentTarget(channel, evt);
  if (!target) {
    log.info('comment', 'skip', { reason: 'unsupported-target', commentScopeId: eventCommentScopeId });
    return;
  }
  const targetDocScopeId = commentDocumentScopeId(target.fileToken);
  const commentThreadScopeId = eventCommentScopeId;
  const runScopeId = commentExecutionScopeId(commentThreadScopeId);
  const docSessionScopeId = commentDocumentSessionScopeId(target.fileToken);
  const legacyDocSessionScopeId = legacyCommentDocumentSessionScopeId(target.fileToken);
  const agentSessionScopeId = docSessionScopeId;

  const ctx = await fetchCommentContext(channel, target, evt).catch((err) => {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (code === 1069307) {
      log.warn('comment', 'no-access', { docDigest: commentTokenDigest(target.fileToken) });
    } else {
      log.fail('comment', err, { step: 'fetchCommentContext' });
    }
    return null;
  });
  if (!ctx?.question) {
    log.info('comment', 'skip', { reason: 'empty-question' });
    return;
  }
  log.info('comment', 'parsed', {
    commentScopeId: runScopeId,
    isWhole: ctx.isWhole,
    questionPreview: preview(ctx.question),
    hasQuote: Boolean(ctx.quote),
  });
  const prompt = buildCommentPrompt(target, ctx);
  const workspace = await resolveCommentWorkingDirectory(
    workspaces.cwdFor(docSessionScopeId) ?? workspaces.cwdFor(legacyDocSessionScopeId),
    controls.profileConfig.workspaces.default,
    managedDefaultWorkspaceForComments(controls),
  );
  const requestedCwd = workspace.requestedCwd;
  const cwdRealpath = workspace.cwdRealpath;
  if (workspace.ok && workspace.fallback) {
    log.info('comment', 'workspace-fallback', {
      reason: workspace.fallback.reason,
      from: workspace.fallback.from,
      to: workspace.fallback.to,
      commentScopeId: runScopeId,
    });
  }
  if (!workspace.ok) {
    log.info('comment', 'skip', {
      reason: 'workspace-rejected',
      code: workspace.reason,
      commentScopeId: runScopeId,
    });
    await postCommentReply(channel, target, evt, `工作目录不可用：${workspace.userVisible}`, {
      isWhole: ctx.isWhole,
    }).catch((err) => {
      log.fail('comment', err, { step: 'postInvalidWorkspaceReply' });
    });
    return;
  }

  // Cloud-doc comments have no streaming UI — the user just sees their
  // @-mention sit there until our reply lands. Mark the triggering reply
  // with a "Typing" reaction up-front so they know we got it; clear it in
  // the finally below regardless of how the run ends.
  const reactionAdded = ctx.targetReplyId
    ? await channel.comments.addReaction(target, ctx.targetReplyId)
    : false;

  try {
    const capability =
      controls.profileConfig.agentKind === 'codex'
        ? codexCapability(controls.profileConfig)
        : claudeCapability(controls.profileConfig);
    const runTimeoutMs = commentRunTimeoutMs(sessions, runScopeId);
    const threadTimeoutMs = commentRunTimeoutMs(sessions, commentThreadScopeId);
    const commentTimeoutMs = runTimeoutMs !== undefined ? runTimeoutMs : threadTimeoutMs;
    if (typeof commentTimeoutMs === 'number') {
      log.info('comment', 'timeout-watchdog', { commentScopeId: runScopeId, timeoutMs: commentTimeoutMs });
    }
    const policy = evaluateRunPolicy({
      scope: {
        source: 'comment',
        actorId: evt.operator.openId,
        commentScopeId: agentSessionScopeId,
        resourceBindings: [{ kind: 'doc', id: targetDocScopeId, verified: true }],
      },
      attachments: [],
      prompt,
      requestedCwd,
      cwdRealpath,
      access: { ok: true, reason: 'comment-mention' },
      capability,
      profileConfig: controls.profileConfig,
      now: Date.now(),
      codexHome: controls.profileConfig.codex?.codexHome,
      inheritCodexHome: controls.profileConfig.codex?.inheritCodexHome,
      ...(typeof commentTimeoutMs === 'number' ? { ttlMs: commentTimeoutMs } : {}),
    });
    if (!policy.ok) {
      log.warn('policy', 'denied', {
        scope: runScopeId,
        source: 'comment',
        code: policy.rejectReason.code,
      });
      return;
    }
    const commentExpiresAt = typeof commentTimeoutMs === 'number' ? policy.expiresAt : undefined;

    const agentSessionRun = markCommentAgentSessionRun(agentSessionScopeId);
    try {
      const canResumeAgentSession = !agentSessionRun.wasActive;
      const catalogEntry = canResumeAgentSession
        ? sessionCatalog?.activeFor({
            scopeId: agentSessionScopeId,
            agentId: capability.agentId,
            cwdRealpath,
            policyFingerprint: policy.policyFingerprint,
          }) ??
          sessionCatalog?.activeFor({
            scopeId: legacyDocSessionScopeId,
            agentId: capability.agentId,
            cwdRealpath,
            policyFingerprint: policy.policyFingerprint,
          })
        : undefined;
      const sessionId =
        canResumeAgentSession && capability.agentId === 'claude'
          ? sessions.resumeFor(docSessionScopeId, cwdRealpath) ??
            sessions.resumeFor(legacyDocSessionScopeId, cwdRealpath)
          : undefined;
      const threadId = capability.agentId === 'codex' ? catalogEntry?.threadId : undefined;
      log.info('comment', 'session', {
        commentScopeId: runScopeId,
        sessionScopeId: agentSessionScopeId,
        resume: Boolean(sessionId ?? threadId),
        sessionScopeActive: agentSessionRun.wasActive,
        cwd: cwdRealpath,
      });

      const execution = await deps.executor.submit({
        scopeId: runScopeId,
        policy,
        sessionId,
        threadId,
        stopGraceMs: getAgentStopGraceMs(controls.cfg),
        observability: {
          profile: controls.profile,
          agent: capability.agentId,
          source: 'comment',
          stage: 'submit',
        },
      }).catch(async (err: unknown) => {
        if (err instanceof RunRejected) {
          log.info('comment', 'skip', {
            reason: err.code,
            commentScopeId: runScopeId,
          });
          const reply = commentRunRejectedReply(err.code);
          if (reply) {
            await postCommentReply(channel, target, evt, reply, { isWhole: ctx.isWhole }).catch((replyErr) => {
              log.fail('comment', replyErr, { step: 'postRunRejectedReply' });
            });
          }
          return undefined;
        }
        throw err;
      });
      if (!execution) return;
      let answer = '';
      let errorMsg: string | undefined;
      let terminal = false;
      let timedOut = false;
      const eventStream = execution.subscribe()[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await nextCommentEvent(eventStream, commentExpiresAt);
          if (next === 'expired') {
            await execution.stop().catch((err) => {
              log.warn('comment', 'expired-stop-failed', {
                commentScopeId: runScopeId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
            timedOut = true;
            terminal = true;
            break;
          }
          if (commentExpiresAt !== undefined && Date.now() > commentExpiresAt) {
            await execution.stop().catch((err) => {
              log.warn('comment', 'expired-stop-failed', {
                commentScopeId: runScopeId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
            timedOut = true;
            terminal = true;
            break;
          }
          if (next.done || execution.handle.interrupted) {
            terminal = true;
            break;
          }
          const e = next.value;
          recordCommentSessionEvent({
            scopeId: agentSessionScopeId,
            sessions,
            sessionCatalog,
            capability,
            policy,
            event: e,
          });
          if (capability.agentId === 'claude' && e.type === 'system' && e.sessionId) {
            sessions.set(docSessionScopeId, e.sessionId, policy.cwdRealpath);
          }
          switch (e.type) {
            case 'text':
              answer += e.delta;
              break;
            case 'tool_use':
            case 'tool_result':
              answer = '';
              break;
            case 'system':
              break;
            case 'error':
              errorMsg = e.message;
              terminal = true;
              break;
            case 'usage':
              break;
            case 'done':
              terminal = true;
              break;
          }
          // Don't wait for the subprocess to actually close stdout — break as soon
          // as we have the final result. Some claude versions hang briefly post-
          // result on telemetry, which would leave the for-await stuck forever.
          if (terminal) break;
        }
      } finally {
        await eventStream.return?.();
      }

      if (timedOut) {
        log.info('comment', 'reply-skip', {
          reason: 'policy-expired',
          commentScopeId: runScopeId,
        });
        await postCommentReply(channel, target, evt, '本次评论任务已超时，请重新 @ 我。', {
          isWhole: ctx.isWhole,
        }).catch((err) => {
          log.fail('comment', err, { step: 'postTimeoutReply' });
        });
        return;
      }

      if (execution.handle.interrupted) {
        log.info('comment', 'reply-skip', {
          reason: 'interrupted',
          commentScopeId: runScopeId,
        });
        return;
      }

      let reply = stripMarkdown(answer.trim());
      if (errorMsg) reply = `⚠️ Claude 报错：${errorMsg}`;
      if (!reply) reply = '（无回复内容）';
      if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

      await postCommentReply(channel, target, evt, reply, { isWhole: ctx.isWhole }).catch((err) => {
        log.fail('comment', err, { step: 'postCommentReply' });
        log.warn('comment', 'reply_failed', {
          commentScopeId: runScopeId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } finally {
      agentSessionRun.release();
    }
  } finally {
    if (reactionAdded && ctx.targetReplyId) {
      await channel.comments.removeReaction(target, ctx.targetReplyId);
    }
  }
}

export type ResolvedTarget = ResolvedCommentTarget;

async function fetchCommentContext(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
): Promise<CommentContext> {
  // The SDK's CommentSurface internalizes the `.get` → paginated `.list`
  // fallback (some comment types return 1069307 on `.get` despite read
  // access). A genuine no-access (1069307 on both) propagates here so the
  // caller's catch can log it as no-access.
  const fetched = await channel.comments.fetch(target, evt.commentId);
  const replies = fetched?.replies ?? [];
  const parsed = extractCommentQuestionFromReplies({ replyId: evt.replyId, replies });
  // The whole thread comes back, but only one reply @-ed the bot. Carry the
  // replies before it as context so the agent sees the discussion it's being
  // pulled into, not just the pointer reply. `targetIdx < 0` (no reply_id, so
  // the parser fell back to the last reply) → everything except that last one.
  const targetIdx = parsed?.targetReplyId
    ? replies.findIndex((reply) => reply.reply_id === parsed.targetReplyId)
    : replies.length - 1;
  const priorReplies = (targetIdx > 0 ? replies.slice(0, targetIdx) : [])
    .map(replyElementsToText)
    .filter((text) => text.length > 0);
  return {
    question: parsed?.question ?? '',
    quote: fetched?.quote,
    isWhole: Boolean(fetched?.isWhole),
    targetReplyId: parsed?.targetReplyId,
    priorReplies,
  };
}

/** Flatten a comment reply's content elements into plain text (text runs and
 * doc links; @-mention `person` elements are dropped as they carry no text). */
function replyElementsToText(reply: CommentReply): string {
  const elements = reply.content?.elements ?? [];
  return elements
    .map((el) => {
      if (el.type === 'text_run') return el.text_run?.text ?? '';
      if (el.type === 'docs_link') return el.docs_link?.url ?? '';
      return '';
    })
    .join('')
    .trim();
}

export function extractCommentQuestionFromReplies(
  input: ExtractCommentQuestionInput,
): ExtractCommentQuestionResult | null {
  let targetReply: CommentReply | undefined;
  if (input.replyId) {
    targetReply = input.replies.find((reply) => reply.reply_id === input.replyId);
  }
  targetReply ??= input.replies.at(-1);
  if (!targetReply) return null;

  const question = replyElementsToText(targetReply);
  return { question, targetReplyId: targetReply.reply_id };
}

export function buildCommentPrompt(
  target: ResolvedTarget,
  ctx: CommentContext,
): string {
  const docUrl = `https://feishu.cn/${target.fileType}/${target.fileToken}`;
  const parts: string[] = [];
  parts.push('我在飞书云文档里被 @了。文档信息：');
  parts.push(`- 链接：${docUrl}`);
  parts.push(`- file_token：${target.fileToken}`);
  parts.push(`- 类型：${target.fileType}`);
  parts.push(
    `- 评论范围：${ctx.isWhole ? '全文评论（针对整篇）' : '行内评论（针对选中文字）'}`,
  );
  if (ctx.quote) {
    parts.push('');
    parts.push(`用户选中的原文：\n> ${ctx.quote.replace(/\n/g, '\n> ')}`);
  }
  if (ctx.priorReplies.length > 0) {
    parts.push('');
    parts.push('这条评论 thread 里此前的讨论（按时间顺序，@你的那条不在其中）：');
    ctx.priorReplies.forEach((text, i) => {
      parts.push(`${i + 1}. ${text}`);
    });
  }
  parts.push('');
  parts.push(`用户的问题：${ctx.question}`);
  parts.push('');
  parts.push(commentReadInstruction(target));
  parts.push('');
  parts.push(
    '评论回复由 bridge 负责：不要调用云文档评论或回复接口，也不要给评论添加或删除 reaction；最终答案直接用纯文本交给 bridge。',
  );
  parts.push('');
  parts.push(
    '回复要求：直接用纯文本，不要 markdown（不要 ** __ # - * > ` 之类的标记），不要代码块；不要输出内部思考、内部分析、读取步骤、工具调用过程或工具日志。若用户要求解释依据，只说明用户可见的依据和结论。云文档评论框不渲染 markdown，会原样显示这些符号。',
  );
  return parts.join('\n');
}

function recordCommentSessionEvent(
  input: Parameters<typeof recordRunSessionEvent>[0],
): void {
  const event =
    input.event.type === 'system'
      ? { ...input.event, cwd: input.policy.cwdRealpath }
      : input.event;
  recordRunSessionEvent({ ...input, event });
}

function commentRunRejectedReply(code: RunRejected['code']): string | undefined {
  switch (code) {
    case 'run-already-active':
      return '当前评论线程已有任务在执行，请稍后再试。';
    case 'pool-full':
      return '当前任务较多，请稍后再试。';
    case 'reconnect-in-progress':
      return '当前 bot 正在重连，请稍后再试。';
    case 'policy-expired':
      return '本次评论任务已超时，请重新 @ 我。';
  }
}

function commentExecutionScopeId(commentThreadScopeId: string): string {
  return `${commentThreadScopeId}:${randomUUID().slice(0, 12)}`;
}

function commentDocumentSessionScopeId(fileToken: string): string {
  return `doc:${commentTokenDigest(fileToken)}`;
}

function legacyCommentDocumentSessionScopeId(fileToken: string): string {
  return `doc:${fileToken}`;
}

function markCommentAgentSessionRun(scopeId: string): {
  wasActive: boolean;
  release(): void;
} {
  const count = activeCommentAgentSessionRuns.get(scopeId) ?? 0;
  activeCommentAgentSessionRuns.set(scopeId, count + 1);
  let released = false;
  return {
    wasActive: count > 0,
    release() {
      if (released) return;
      released = true;
      const next = (activeCommentAgentSessionRuns.get(scopeId) ?? 1) - 1;
      if (next > 0) {
        activeCommentAgentSessionRuns.set(scopeId, next);
      } else {
        activeCommentAgentSessionRuns.delete(scopeId);
      }
    },
  };
}

async function resolveCommentWorkingDirectory(
  configuredCwd: string | undefined,
  defaultCwd: string | undefined,
  managedFallbackCwd: string,
): Promise<
  | {
      ok: true;
      requestedCwd: string;
      cwdRealpath: string;
      fallback?: { from: string; to: 'profile-default' | 'managed-default'; reason: string };
    }
  | {
      ok: false;
      requestedCwd: string;
      cwdRealpath: string;
      reason: string;
      userVisible: string;
    }
> {
  const failures: string[] = [];
  if (configuredCwd) {
    const configured = await resolveWorkingDirectory(configuredCwd);
    if (configured.ok) return configured;
    failures.push(configured.userVisible);
    if (defaultCwd) {
      const fallback = await resolveWorkingDirectory(defaultCwd);
      if (fallback.ok) {
        return {
          ...fallback,
          fallback: {
            from: 'document',
            to: 'profile-default',
            reason: configured.reason,
          },
        };
      }
      failures.push(fallback.userVisible);
      return resolveManagedCommentWorkingDirectory(
        managedFallbackCwd,
        'document/profile-default',
        fallback.reason,
        failures,
      );
    }
    return resolveManagedCommentWorkingDirectory(managedFallbackCwd, 'document', configured.reason, failures);
  }

  if (!defaultCwd) {
    return resolveManagedCommentWorkingDirectory(
      managedFallbackCwd,
      'missing-default',
      'missing-default-cwd',
      failures,
    );
  }
  const workspace = await resolveWorkingDirectory(defaultCwd);
  if (workspace.ok) return workspace;
  failures.push(workspace.userVisible);
  return resolveManagedCommentWorkingDirectory(managedFallbackCwd, 'profile-default', workspace.reason, failures);
}

async function resolveManagedCommentWorkingDirectory(
  managedFallbackCwd: string,
  fallbackFrom: string,
  fallbackReason: string,
  failures: string[],
): Promise<
  | {
      ok: true;
      requestedCwd: string;
      cwdRealpath: string;
      fallback: { from: string; to: 'managed-default'; reason: string };
    }
  | {
      ok: false;
      requestedCwd: string;
      cwdRealpath: string;
      reason: string;
      userVisible: string;
    }
> {
  try {
    await mkdir(managedFallbackCwd, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      requestedCwd: managedFallbackCwd,
      cwdRealpath: managedFallbackCwd,
      reason: 'managed-fallback-unavailable',
      userVisible: [
        ...failures,
        `托管工作目录不可用：${err instanceof Error ? err.message : String(err)}`,
      ].join('；'),
    };
  }
  const workspace = await resolveWorkingDirectory(managedFallbackCwd);
  if (workspace.ok) {
    return {
      ...workspace,
      fallback: {
        from: fallbackFrom,
        to: 'managed-default',
        reason: fallbackReason,
      },
    };
  }
  return {
    ok: false,
    requestedCwd: managedFallbackCwd,
    cwdRealpath: managedFallbackCwd,
    reason: workspace.reason,
    userVisible: [...failures, workspace.userVisible].join('；'),
  };
}

function managedDefaultWorkspaceForComments(controls: Controls): string {
  return resolveAppPaths({
    rootDir: dirname(controls.configPath),
    profile: controls.profile,
  }).defaultWorkspaceDir;
}

function commentReadInstruction(target: ResolvedTarget): string {
  if (target.fileType === 'doc' || target.fileType === 'docx') {
    return (
      '读取文档内容：优先使用当前 docs v2 读取命令：\n' +
      `  \`lark-cli docs +fetch --api-version v2 --doc ${target.fileToken} --doc-format markdown\`\n` +
      '如果本机 lark-cli 不支持上述参数，不要在同一错误上反复重试；使用当前可用的等价读取命令读取同一 file_token。'
    );
  }
  if (target.fileType === 'sheet') {
    return (
      '读取表格内容：这是 sheet 类型，不要使用 docs +fetch。请按当前可用的表格读取工具或本机 lark-cli 支持的表格读取命令读取同一 file_token；如果命令参数不兼容，不要在同一错误上反复重试。'
    );
  }
  return (
    '读取文件内容：这是 file 类型，不要使用 docs +fetch。请按当前可用的云空间文件工具或本机 lark-cli 支持的文件读取/下载命令处理同一 file_token；如果命令参数不兼容，不要在同一错误上反复重试。'
  );
}

function isBridgeSelfReply(channel: LarkChannel, evt: CommentEvent): boolean {
  const botOpenId = (channel as { botIdentity?: { openId?: string } }).botIdentity?.openId;
  if (botOpenId && evt.operator.openId === botOpenId) return true;

  const raw = evt as unknown as Record<string, unknown>;
  if (raw.bridgeReply === true) return true;
  if (raw.bridge_reply === true) return true;

  const metadata = raw.replyMetadata ?? raw.reply_metadata ?? raw.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const record = metadata as Record<string, unknown>;
  return record.bridge === true || record.bridgeReply === true || record.source === 'lark-channel-bridge';
}

/**
 * Strip the most common markdown markers so a plain-text comment doesn't
 * show literal `**` / `#` / `> ` etc. Conservative — only touches bold,
 * italic, headings, blockquote, list bullets, and inline code.
 */
export function stripMarkdown(s: string): string {
  return s
    // headings: "# foo" -> "foo"
    .replace(/^#{1,6}\s+/gm, '')
    // bold/italic: **foo** / __foo__ / *foo* / _foo_
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
    // inline code: `foo`
    .replace(/`([^`]+)`/g, '$1')
    // unordered list bullets: "- foo" / "* foo"
    .replace(/^[-*]\s+/gm, '')
    // blockquote
    .replace(/^>\s?/gm, '')
    // remove fenced code-block backticks but keep contents
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '');
}

function commentRunTimeoutMs(
  sessions: SessionStore,
  scopeId: string,
): number | null | undefined {
  const scopeOverride = sessions.getIdleTimeoutMinutes(scopeId);
  if (scopeOverride !== undefined) {
    return scopeOverride > 0 ? scopeOverride * 60_000 : null;
  }
  return undefined;
}

async function nextCommentEvent(
  iterator: AsyncIterator<AgentEvent>,
  expiresAt: number | undefined,
): Promise<IteratorResult<AgentEvent> | 'expired'> {
  if (expiresAt === undefined) {
    return iterator.next();
  }
  const delayMs = Math.max(0, expiresAt - Date.now() + 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), delayMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postCommentReply(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
  text: string,
  opts: { isWhole?: boolean } = {},
): Promise<void> {
  // CommentSurface tries in-thread first and, on the 1069302 that whole-doc
  // comments return (no thread, only a flat list), falls back to posting a
  // fresh top-level comment. When we already know it's whole-document, skip
  // the doomed probe with `topLevel`.
  await channel.comments.reply(target, evt.commentId, text, { topLevel: opts.isWhole });
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
