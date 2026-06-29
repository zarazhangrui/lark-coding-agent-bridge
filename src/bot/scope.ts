import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ChatModeCache } from './chat-mode-cache';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / group**: scope = `chatId`. Replies in regular groups thread the
 *    UI but share the chat's session (matches user expectation).
 *  - **topic group**: scope = `${chatId}:${threadId}` — each topic is an
 *    independent conversation with its own session / cwd / pending queue.
 *    Topic-group top-level messages (no threadId, rare) fall back to chatId.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
): Promise<string> {
  const mode = await cache.resolve(channel, chatId);
  if (mode === 'topic' && threadId) {
    return `${chatId}:${threadId}`;
  }
  return chatId;
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  return scopeFor(channel, msg.chatId, msg.threadId, cache);
}
