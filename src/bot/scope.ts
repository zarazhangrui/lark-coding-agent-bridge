import type { NormalizedMessage } from '@larksuite/channel';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / group**: scope = `chatId`.
 *  - **threaded messages**: scope = `${chatId}:${threadId}` — each Feishu
 *    topic / converted thread gets its own session / cwd / pending queue.
 *
 * Callers typically compute this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export function scopeFor(chatId: string, threadId: string | undefined): string {
  if (isThreadedScope(threadId)) return `${chatId}:${threadId}`;
  return chatId;
}

export function isThreadedScope(threadId: string | undefined): threadId is string {
  return Boolean(threadId);
}

/** Convenience overload from a NormalizedMessage. */
export function scopeForMessage(msg: NormalizedMessage): string {
  return scopeFor(msg.chatId, msg.threadId);
}
