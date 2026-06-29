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
  // this same id (merge_forward case). For nested merge_forwards inside, fall
  // back to a fresh API call.
  const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    try {
      const subItems = await channel.fetchRawMessage(mid, {
        cardContentType: 'user_card_content',
      });
      return subItems.map(preExpandInteractive);
    } catch {
      return [];
    }
  };

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
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
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
