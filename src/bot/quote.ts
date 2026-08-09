import type {
  ApiMessageItem,
  LarkChannel,
  RawMessageEvent,
} from '@larksuite/channel';
import { normalize } from '@larksuite/channel';
import { log } from '../core/logger';
import { expandInteractiveCard } from './interactive-card';

export interface QuotedContext {
  messageId: string;
  senderId: string;
  senderName?: string;
  /** Human vs bot, derived from the Feishu `sender.sender_type`. Undefined when
   * the source item didn't carry it (single-quote fetch path). */
  senderType?: 'user' | 'bot';
  /** ISO timestamp of the quoted message's creation. Empty when SDK can't
   * resolve it from the fetched item. */
  createdAt: string;
  /** Normalized human-readable content. For text/post this is plain text;
   * for merge_forward the SDK expands the tree into `<forwarded_messages>...
   * </forwarded_messages>` (capped at 50 items by the SDK). */
  content: string;
  rawContentType: string;
}

/**
 * Fetch and normalize the content of a message that the user is reply-quoting.
 *
 * Why this is non-trivial: `im.v1.message.get` returns a flat `ApiMessageItem`
 * list (parent + descendants for merge_forward), but the bot intake pipeline
 * deals in `NormalizedMessage`. We synthesize a `RawMessageEvent` from the
 * parent item and feed it through the SDK's `normalize` so merge_forward gets
 * the same `<forwarded_messages>` expansion path that live events do.
 *
 * `chatId` / `chatType` on the synthesized raw event don't have to be real —
 * normalize doesn't validate them, and downstream only uses the resulting
 * `content`. Same for mentions (we don't pass any).
 */
/**
 * Rewrite an interactive sub-message's body.content so the SDK's
 * `convertInteractive` → `walkCard` finds a text node and emits real card
 * content instead of the literal `[interactive card]` placeholder. We wrap
 * our expanded `<interactive_card>` block as a `plain_text` node — that's
 * one of the three tags walkCard treats as text-bearing
 * (plain_text / lark_md / markdown).
 *
 * This is the merge_forward fix: sub-messages bypass the parent-level
 * expansion because the SDK assembles `<forwarded_messages>` internally from
 * each sub's flattened form, so we have to inject expansion at the sub-fetch
 * layer.
 */
function preExpandInteractive(item: ApiMessageItem): ApiMessageItem {
  if (item.msg_type !== 'interactive') return item;
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return item;
  const expanded = expandInteractiveCard('[interactive card]', raw);
  // expandInteractiveCard returns the placeholder unchanged when there's
  // nothing to expand — skip rewriting in that case to avoid double wrapping.
  if (expanded === '[interactive card]') return item;
  const wrapper = JSON.stringify({ tag: 'plain_text', content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}

export async function fetchQuotedContext(
  channel: LarkChannel,
  messageId: string,
): Promise<QuotedContext | undefined> {
  let items: ApiMessageItem[];
  try {
    // Ask for the original card JSON (incl. v2 user_dsl) instead of the
    // default v1-canonical fallback that strips it.
    items = await channel.fetchRawMessage(messageId, {
      cardContentType: 'user_card_content',
    });
  } catch (err) {
    log.warn('quote', 'fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return undefined;

  // Reuse the already-fetched items when the SDK re-asks for sub-messages of
  // this same id (merge_forward case). For nested merge_forwards inside, fetch
  // fresh — and let a fetch failure throw so it surfaces as a fetch_failed
  // forward rather than a silently-empty one (see fetchSubTreeItems).
  const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    const subItems = await fetchSubTreeItems(channel, mid);
    return subItems.map(preExpandInteractive);
  };

  return normalizeItemToQuoted(channel, parent, fetchSubMessages);
}

function mapSenderType(raw: unknown): 'user' | 'bot' | undefined {
  if (raw === 'user') return 'user';
  if (raw === 'app' || raw === 'bot') return 'bot';
  return undefined;
}

/**
 * Normalize a single fetched message item (from `im.v1.message.get` or
 * `im.v1.message.list`) into a {@link QuotedContext}. Shared by the reply-quote
 * path and the topic-context path. `fetchSubMessages` resolves merge_forward
 * children — callers decide whether to reuse an already-fetched batch or fetch
 * fresh.
 */
async function normalizeItemToQuoted(
  channel: LarkChannel,
  parent: ApiMessageItem,
  fetchSubMessages: (mid: string) => Promise<ApiMessageItem[]>,
): Promise<QuotedContext | undefined> {
  if (!parent.message_id) return undefined;
  const senderOpenId = parent.sender?.id;
  const fakeRaw: RawMessageEvent = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: '',
      chat_type: 'group',
      message_type: parent.msg_type ?? 'text',
      content: parent.body?.content ?? '',
      create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
      mentions: parent.mentions,
    },
  };

  const botIdentity = channel.botIdentity ?? { openId: '', name: '' };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false,
    });
    const createMs = parent.create_time
      ? Number.parseInt(String(parent.create_time), 10)
      : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? '',
      senderName: normalized.senderName,
      senderType: mapSenderType(parent.sender?.sender_type),
      createdAt: Number.isFinite(createMs) && createMs > 0
        ? new Date(createMs).toISOString()
        : '',
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? 'text',
    };
  } catch (err) {
    log.warn('quote', 'normalize-failed', {
      messageId: parent.message_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Fetch a Feishu topic's upstream messages (chronological) so the agent has the
 * conversation it's being pulled into. Feishu's `im.v1.message.list` with
 * `container_id_type=thread` returns every message in the topic — including the
 * root that may never have @-mentioned the bot. Used only on the bot's first
 * engagement in a topic (an already-engaged topic keeps its history in the
 * resumed session).
 *
 * `excludeIds` drops the triggering messages and any explicit reply-quotes so
 * they aren't duplicated. Capped at `maxMessages` (keeps the most recent when
 * the topic is longer). Returns `[]` on any error — context is best-effort.
 */
export async function fetchTopicContext(
  channel: LarkChannel,
  threadId: string,
  opts: { maxMessages: number; excludeIds?: Set<string> },
): Promise<QuotedContext[]> {
  const collected: ApiMessageItem[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = (res as {
        data?: { items?: ApiMessageItem[]; messages?: ApiMessageItem[]; has_more?: boolean; page_token?: string };
      }).data;
      const items = data?.items ?? data?.messages ?? [];
      collected.push(...items);
      pageToken = data?.has_more ? data.page_token : undefined;
    } while (pageToken && collected.length < opts.maxMessages * 4);
  } catch (err) {
    log.warn('topic', 'context-fetch-failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const exclude = opts.excludeIds ?? new Set<string>();
  const relevant = collected
    .filter(
      (m) => m.message_id && !exclude.has(m.message_id) && !(m as { deleted?: boolean }).deleted,
    )
    .slice(-opts.maxMessages);

  const out: QuotedContext[] = [];
  for (const item of relevant) {
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      const source = mid === item.message_id ? [item] : await fetchSubTreeItems(channel, mid);
      return source.map(preExpandInteractive);
    };
    const quoted = await normalizeItemToQuoted(channel, item, fetchSubMessages);
    if (quoted) out.push(quoted);
  }
  return out;
}

/**
 * Fetch a nested sub-message's items for merge_forward expansion. Unlike a
 * best-effort context fetch, this RE-THROWS on failure: the SDK's
 * convertMergeForward turns a throw into the `<forwarded_messages
 * status="fetch_failed"/>` sentinel, so a transient fetch failure surfaces as
 * fetch_failed instead of being silently flattened to an empty forward — the
 * same distinction @larksuite/channel makes on the live-event path. Passed into
 * `normalize` as `fetchSubMessages`.
 */
async function fetchSubTreeItems(
  channel: LarkChannel,
  messageId: string,
): Promise<ApiMessageItem[]> {
  try {
    return await channel.fetchRawMessage(messageId, { cardContentType: 'user_card_content' });
  } catch (err) {
    log.warn('quote', 'sub-fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Render one or more quoted contexts as an XML block intended to sit at the
 * top of the prompt body (after `<bridge_context>`, before the user's actual
 * question). Returns empty string when there are no quotes — keeps callers
 * concatenating without conditional checks.
 */
export function renderQuotedBlock(quotes: QuotedContext[]): string {
  if (quotes.length === 0) return '';
  const parts = quotes.map((q) => {
    const attrs = [
      `id="${q.messageId}"`,
      q.senderId ? `sender_id="${q.senderId}"` : '',
      q.senderName ? `sender_name="${q.senderName}"` : '',
      q.createdAt ? `created_at="${q.createdAt}"` : '',
      `type="${q.rawContentType}"`,
    ]
      .filter(Boolean)
      .join(' ');
    return `<quoted_message ${attrs}>\n${q.content}\n</quoted_message>`;
  });
  return parts.join('\n');
}
