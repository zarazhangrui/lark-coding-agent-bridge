import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

interface ManagedEntry {
  kind: 'card-id' | 'raw-card';
  cardId?: string;
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
 * Create a CardKit 2.0 card entity and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * `recipientId` is routed by its id prefix (channel.send infers
 * `receive_id_type`): `oc_*` → chat, `ou_*` → direct message to that user
 * (Lark auto-resolves the p2p chat). If `replyTo` is provided, the card
 * threads under that message — only meaningful for chat sends.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  recipientId: string,
  card: object,
  opts: { replyTo?: string; replyInThread?: boolean } = {},
): Promise<ManagedCardSendResult> {
  const { cardId } = await channel.createCard(card);
  const sendOpts = opts.replyTo
    ? { replyTo: opts.replyTo, ...(opts.replyInThread ? { replyInThread: true } : {}) }
    : undefined;
  let messageId: string;
  try {
    ({ messageId } = await channel.send(recipientId, { cardId }, sendOpts));
  } catch (err) {
    log.warn('card', 'managed-send-raw-fallback', {
      err: err instanceof Error ? err.message : String(err),
      replyTo: opts.replyTo,
      replyInThread: opts.replyInThread === true,
    });
    ({ messageId } = await channel.send(recipientId, { card }, sendOpts));
    byMessageId.set(messageId, { kind: 'raw-card', sequence: 0 });
    return { messageId, cardId };
  }
  byMessageId.set(messageId, { kind: 'card-id', cardId, sequence: 0 });
  return { messageId, cardId };
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. CardKit card-id sends use the per-card sequence required by the
 * card server; raw-card fallback sends can only be updated by messageId, so the
 * local sequence is diagnostic metadata for that path.
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
    if (entry.kind === 'card-id') {
      await channel.updateCardById(entry.cardId!, card, entry.sequence);
    } else {
      await channel.updateCard(messageId, card);
    }
  } catch (err) {
    log.fail('card', err, {
      step: 'managed-update',
      kind: entry.kind,
      cardId: entry.cardId,
      seq: entry.sequence,
    });
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
