import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ChatModeCache } from './chat-mode-cache';

/**
 * A message belongs to an isolated thread iff Feishu gave it a `thread_id`.
 *
 * Empirically (verified against live intake logs) `thread_id` is populated
 * **only** when a message lives in a Feishu thread — both topic-group topics
 * and "convert to topic" threads started inside a plain group carry an
 * `omt_…` thread_id. Ordinary messages and quote-replies (which only carry
 * `root_id` / `parent_id`) do not. So thread membership — not the chat's mode
 * — is the right axis for session isolation: each thread becomes its own
 * conversation (own session / cwd / pending queue), and everything else
 * shares the chat-level session.
 */
export function isThreadedScope(threadId: string | undefined): threadId is string {
  return Boolean(threadId);
}

/**
 * Compute the **session scope** for a message.
 *
 *  - **threaded** (topic-group topic, or a plain-group "convert to topic"
 *    thread): scope = `${chatId}:${threadId}` — an independent conversation.
 *  - **everything else** (p2p, plain group top-level, quote-reply): scope =
 *    `chatId`. Quote-replies thread the UI but share the chat's session.
 *
 * Async because chat mode requires an API lookup (cached after first hit);
 * the mode is still resolved so callers can warm the cache, but scope keys
 * off thread membership alone.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
): Promise<string> {
  // Resolve (and cache) chat mode so downstream consumers stay warm.
  await cache.resolve(channel, chatId);
  return isThreadedScope(threadId) ? `${chatId}:${threadId}` : chatId;
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  return scopeFor(channel, msg.chatId, msg.threadId, cache);
}
