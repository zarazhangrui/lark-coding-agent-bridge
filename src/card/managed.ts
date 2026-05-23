import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card instance and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * `recipient` controls where the card lands:
 *   - omitted (default) — send to the chat identified by `recipientId`
 *     (`receive_id_type: chat_id`). Backwards-compatible with the original
 *     2-arg `sendManagedCard(channel, chatId, card)` shape.
 *   - `{ receiveType: 'open_id' }` — send as a direct message to the user
 *     whose open_id is in `recipientId`. Lark auto-resolves the p2p chat,
 *     so the caller doesn't need to know its chat_id.
 *
 * If `replyTo` is provided, posts via `im.v1.message.reply` so the card
 * threads under the user's triggering message — only meaningful for
 * chat-id sends.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  recipientId: string,
  card: object,
  opts: { replyTo?: string; receiveType?: 'chat_id' | 'open_id' } = {},
): Promise<ManagedCardSendResult> {
  const created = await channel.rawClient.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
  if (!cardId) {
    throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  let messageId: string | undefined;
  if (opts.replyTo) {
    const sent = await channel.rawClient.im.v1.message.reply({
      path: { message_id: opts.replyTo },
      data: { msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  } else {
    const receiveType = opts.receiveType ?? 'chat_id';
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: receiveType },
      data: { receive_id: recipientId, msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  }
  if (!messageId) {
    throw new Error('send card-by-reference returned no message_id');
  }

  byMessageId.set(messageId, { cardId, sequence: 0 });
  return { messageId, cardId };
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. Auto-increments and tracks the per-card sequence so updates
 * can't be reordered or rejected by the cardkit server.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence: entry.sequence,
      },
    });
  } catch (err) {
    log.fail('card', err, { step: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    throw err;
  }
}

/** True iff we have the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
