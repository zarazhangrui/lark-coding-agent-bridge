import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export type ChatMode = 'p2p' | 'group' | 'topic';

/**
 * In-memory cache for `channel.getChatMode()` results.
 *
 * Why: chat mode (`p2p` / `group` / `topic`) doesn't change within a chat's
 * lifetime — but SDK doesn't expose it on the message event (Feishu server
 * never includes it in the payload). The only way to know is one extra
 * `im.v1.chat.get` API call per chat. We cache by chatId so each chat costs
 * at most one round-trip after which it's all in-memory.
 *
 * On lookup failure (network / permission / unknown chatId) we **fall back
 * to 'group'** — that's the conservative default since it means "treat as
 * a normal chat, one session per chatId, no thread split". Doesn't crash.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  async resolve(channel: LarkChannel, chatId: string): Promise<ChatMode> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info('chat', 'mode-resolved', { chatId, mode });
      return mode;
    } catch (err) {
      log.warn('chat', 'mode-resolve-failed', {
        chatId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't poison the cache — next message gets another try.
      return 'group';
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
