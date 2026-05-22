import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { menuCard } from '../card/templates';
import { log } from '../core/logger';

/**
 * The bot's currently-pinned menu message per chat. Lets us unpin the previous
 * menu before pinning a fresh one, so there's always exactly one menu pin and
 * it never goes stale. In-memory (lost on restart) — after a restart we simply
 * don't unpin the old one, which at worst leaves a single stale pin.
 */
const pinnedMenuByChat = new Map<string, string>();

/**
 * Post the compact "project console" card to a chat and pin it to the top so
 * the menu stays one tap away — the closest thing to a persistent menu inside
 * group chats (Feishu's native bot menu is DM-only).
 *
 * Pinning is best-effort: the Pin API only works in group chats and needs the
 * bot to be a member, so DM / permission failures are logged and swallowed —
 * the card itself is still sent either way.
 */
export async function sendAndPinMenu(
  channel: LarkChannel,
  currentCwd: string | undefined,
  named: Record<string, string>,
  chatId: string,
): Promise<void> {
  const card = menuCard(currentCwd, Object.keys(named).length);
  const { messageId } = await channel.send(chatId, { card });

  // Drop our previous menu pin in this chat (only ours — never the user's own
  // pins) so menus don't accumulate.
  const prev = pinnedMenuByChat.get(chatId);
  if (prev) {
    await channel.rawClient.im.v1.pin
      .delete({ path: { message_id: prev } })
      .catch(() => {});
  }
  try {
    await channel.rawClient.im.v1.pin.create({ data: { message_id: messageId } });
    pinnedMenuByChat.set(chatId, messageId);
  } catch (err) {
    pinnedMenuByChat.delete(chatId);
    log.warn('menu', 'pin-failed', {
      chatId: chatId.slice(-6),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
