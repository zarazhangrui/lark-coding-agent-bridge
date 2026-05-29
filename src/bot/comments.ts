import { homedir } from 'node:os';
import type { CommentEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { Controls } from '../commands';
import { isUserAllowed } from '../config/schema';
import { log } from '../core/logger';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { addCommentReaction, removeCommentReaction } from './reaction';

export interface CommentDeps {
  channel: LarkChannel;
  evt: CommentEvent;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
}

// File types supported by drive.v1.fileComment.get; other types (slides,
// bitable, mindnote) use different APIs and are out of scope for now.
const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'file']);

const REPLY_MAX_CHARS = 2000;

interface ReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}
interface CommentReply {
  reply_id?: string;
  content?: { elements?: ReplyContentElement[] };
}
interface CommentGetResponse {
  data?: { reply_list?: { replies?: CommentReply[] }; quote?: string; is_whole?: boolean };
}
interface CommentListItem {
  comment_id?: string;
  reply_list?: { replies?: CommentReply[] };
  is_whole?: boolean;
  quote?: string;
}
interface CommentListResponse {
  data?: { items?: CommentListItem[]; has_more?: boolean; page_token?: string };
}

interface CommentContext {
  question: string;
  quote?: string;
  isWhole: boolean;
  /** The reply_id of the reply that contains the @bot mention — the anchor
   * we react on. Undefined when we couldn't pinpoint a reply (top-level
   * comment with no replies fetched, etc.). */
  targetReplyId?: string;
}

/**
 * Handle a `comment` event: when the bot is @-mentioned in a cloud-doc
 * comment, fetch the comment text, run the agent, and post the answer as
 * a reply in the same comment thread.
 */
export async function handleCommentMention(deps: CommentDeps): Promise<void> {
  const { channel, evt, agent, sessions, workspaces, controls } = deps;
  // Log every comment event we receive, regardless of whether we'll act on it.
  // `mentionedBot` and `replyId` here let us tell apart top-level comments
  // from thread replies (the latter requires SDK ≥ 1.65.0-alpha.0).
  log.info('comment', 'enter', {
    doc: evt.fileToken,
    fileType: evt.fileType,
    commentId: evt.commentId,
    replyId: evt.replyId,
    mentionedBot: evt.mentionedBot,
    sender: evt.operator.openId,
  });
  if (!evt.mentionedBot) {
    log.info('comment', 'skip', { reason: 'not-mentioned' });
    return;
  }
  if (!isUserAllowed(controls, evt.operator.openId, true)) {
    log.info('comment', 'skip-not-allowed-user', {
      sender: evt.operator.openId.slice(-6),
    });
    return;
  }
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
    log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
    return;
  }

  const target = await resolveTarget(channel, evt);
  if (!target) {
    log.info('comment', 'skip', { reason: 'unsupported-target' });
    return;
  }

  const ctx = await fetchCommentContext(channel, target, evt).catch((err) => {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (code === 1069307) {
      log.warn('comment', 'no-access', { token: target.fileToken });
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
    isWhole: ctx.isWhole,
    questionPreview: preview(ctx.question),
    hasQuote: Boolean(ctx.quote),
  });
  const prompt = buildCommentPrompt(target, ctx);

  // One Claude session per cloud-doc; subsequent @-mentions in the same
  // doc continue the same conversation. cwd defaults to $HOME — the agent
  // probably won't do filesystem work for doc replies but we keep a sane
  // default in case it does.
  const synthChatId = `doc:${evt.fileToken}`;
  const cwd = workspaces.cwdFor(synthChatId) ?? homedir();
  const resumeFrom = sessions.resumeFor(synthChatId, cwd);
  log.info('comment', 'session', { synthChatId, resumeFrom: resumeFrom ?? null, cwd });

  // Cloud-doc comments have no streaming UI — the user just sees their
  // @-mention sit there until our reply lands. Mark the triggering reply
  // with a "Typing" reaction up-front so they know we got it; clear it in
  // the finally below regardless of how the run ends.
  const reactionAdded = ctx.targetReplyId
    ? await addCommentReaction(channel, target.fileToken, target.fileType, ctx.targetReplyId)
    : false;

  try {
    const run = agent.run({ prompt, sessionId: resumeFrom, cwd });
    let answer = '';
    let errorMsg: string | undefined;
    let terminal = false;
    for await (const e of run.events) {
      switch (e.type) {
        case 'text':
          answer += e.delta;
          break;
        case 'system':
          if (e.sessionId) {
            const effectiveCwd = e.cwd ?? cwd;
            sessions.set(synthChatId, e.sessionId, effectiveCwd);
          }
          break;
        case 'error':
          errorMsg = e.message;
          terminal = true;
          break;
        case 'usage':
          if (e.costUsd !== undefined) {
            log.info('comment', 'usage', { costUsd: Number(e.costUsd.toFixed(4)) });
          }
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
    // Reap the subprocess if it didn't exit on its own. No-op if already gone.
    await run.stop();

    let reply = stripMarkdown(answer.trim());
    if (errorMsg) reply = `⚠️ Claude 报错：${errorMsg}`;
    if (!reply) reply = '（无回复内容）';
    if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

    await postCommentReply(channel, target, evt, reply).catch((err) => {
      log.fail('comment', err, { step: 'postCommentReply' });
    });
  } finally {
    if (reactionAdded && ctx.targetReplyId) {
      await removeCommentReaction(
        channel,
        target.fileToken,
        target.fileType,
        ctx.targetReplyId,
      );
    }
  }
}

interface ResolvedTarget {
  fileToken: string;
  fileType: 'doc' | 'docx' | 'sheet' | 'file';
}

/**
 * Resolve the (fileToken, fileType) we should hit for the comment APIs.
 * If the event token is a wiki node, swap to the underlying obj_token.
 * Otherwise pass through.
 */
async function resolveTarget(
  channel: LarkChannel,
  evt: CommentEvent,
): Promise<ResolvedTarget | null> {
  const passthrough: ResolvedTarget = {
    fileToken: evt.fileToken,
    fileType: evt.fileType as ResolvedTarget['fileType'],
  };
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) return null;

  // Try wiki node lookup; if the token isn't a wiki node, this throws and we
  // fall back to the original token.
  try {
    const r = (await channel.rawClient.wiki.v2.space.getNode({
      params: { token: evt.fileToken },
    })) as {
      data?: { node?: { obj_token?: string; obj_type?: string } };
    };
    const node = r?.data?.node;
    if (node?.obj_token && node.obj_type && SUPPORTED_FILE_TYPES.has(node.obj_type)) {
      log.info('comment', 'wiki-resolved', {
        objToken: node.obj_token,
        objType: node.obj_type,
      });
      return {
        fileToken: node.obj_token,
        fileType: node.obj_type as ResolvedTarget['fileType'],
      };
    }
  } catch {
    // not a wiki node — fall through to passthrough
  }
  return passthrough;
}

async function fetchCommentContext(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
): Promise<CommentContext> {
  // Try .get first; for some comment types (block-anchored, etc.) it returns
  // 1069307 even when we have read permission. Fall back to .list.
  let replies: CommentReply[] = [];
  let quote: string | undefined;
  let isWhole = false;
  try {
    const r = (await channel.rawClient.drive.v1.fileComment.get({
      params: { file_type: target.fileType },
      path: { file_token: target.fileToken, comment_id: evt.commentId },
    })) as CommentGetResponse;
    replies = r?.data?.reply_list?.replies ?? [];
    quote = r?.data?.quote || undefined;
    isWhole = Boolean(r?.data?.is_whole);
  } catch (err) {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    log.warn('comment', 'get-failed-fallback-list', { code });
    const found = await findCommentViaList(channel, target, evt.commentId);
    replies = found?.reply_list?.replies ?? [];
    quote = found?.quote || undefined;
    isWhole = Boolean(found?.is_whole);
  }

  const target_reply =
    (evt.replyId ? replies.find((rr) => rr.reply_id === evt.replyId) : null) ??
    replies[replies.length - 1];
  const elements = target_reply?.content?.elements ?? [];
  const question = elements
    .map((el) => {
      if (el.type === 'text_run') return el.text_run?.text ?? '';
      if (el.type === 'docs_link') return el.docs_link?.url ?? '';
      return '';
    })
    .join('')
    .trim();

  return { question, quote, isWhole, targetReplyId: target_reply?.reply_id };
}

async function findCommentViaList(
  channel: LarkChannel,
  target: ResolvedTarget,
  commentId: string,
): Promise<CommentListItem | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = (await channel.rawClient.drive.v1.fileComment.list({
      params: {
        file_type: target.fileType,
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      path: { file_token: target.fileToken },
    })) as CommentListResponse;
    const items = r?.data?.items ?? [];
    const hit = items.find((it) => it.comment_id === commentId);
    if (hit) return hit;
    if (!r?.data?.has_more || !r.data.page_token) break;
    pageToken = r.data.page_token;
  }
  return null;
}

function buildCommentPrompt(target: ResolvedTarget, ctx: CommentContext): string {
  // Construct a doc URL Claude can hand to lark-cli. The exact subdomain
  // depends on the user's tenant, but feishu.cn / larksuite.com generic
  // hosts redirect properly within the tenant.
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
  parts.push('');
  parts.push(`用户的问题：${ctx.question}`);
  parts.push('');
  parts.push(
    '需要读文档内容时，可以用 lark-cli：\n' +
      `  \`lark-cli docs +fetch --doc ${target.fileToken}\``,
  );
  parts.push('');
  parts.push(
    '回复要求：直接用纯文本，不要 markdown（不要 ** __ # - * > ` 之类的标记），不要代码块。云文档评论框不渲染 markdown，会原样显示这些符号。',
  );
  return parts.join('\n');
}

/**
 * Strip the most common markdown markers so a plain-text comment doesn't
 * show literal `**` / `#` / `> ` etc. Conservative — only touches bold,
 * italic, headings, blockquote, list bullets, and inline code.
 */
function stripMarkdown(s: string): string {
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

async function postCommentReply(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
  text: string,
): Promise<void> {
  // First try replying in-thread. SDK doesn't expose
  // drive.v1.fileCommentReply.create, so we go through the generic
  // Client.request which still handles auth.
  const url = `/open-apis/drive/v1/files/${encodeURIComponent(target.fileToken)}/comments/${encodeURIComponent(
    evt.commentId,
  )}/replies?file_type=${encodeURIComponent(target.fileType)}`;
  try {
    await channel.rawClient.request({
      method: 'POST',
      url,
      data: { content: { elements: [{ type: 'text_run', text_run: { text } }] } },
    });
    log.info('comment', 'replied', { mode: 'in-thread' });
    return;
  } catch (err) {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    // 1069302: whole-document comments don't accept replies — they have no
    // thread, only a flat list. Fall back to posting a fresh top-level
    // comment that quotes the user's question.
    if (code !== 1069302) throw err;
    log.warn('comment', 'reply-rejected-fallback-create', { code });
  }

  await channel.rawClient.drive.v1.fileComment.create({
    params: { file_type: target.fileType as 'doc' | 'docx' },
    path: { file_token: target.fileToken },
    data: {
      reply_list: {
        replies: [{ content: { elements: [{ type: 'text_run', text_run: { text } }] } }],
      },
    },
  });
  log.info('comment', 'replied', { mode: 'new-top-level' });
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
