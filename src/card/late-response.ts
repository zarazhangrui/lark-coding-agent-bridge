import type { CardActionEvent, CardActionResponse } from '@larksuite/channel';

interface CallbackClient {
  request<T>(input: { method: string; url: string; data: unknown }): Promise<T>;
}

/** Complete a slow interaction with one delayed-update call using its callback token.
 * No raw event or token is logged, and no additional group message is sent. */
export async function deliverLateCardResponse(
  client: CallbackClient, event: CardActionEvent, response: CardActionResponse,
): Promise<void> {
  const card = response.card as { type?: unknown; data?: unknown } | undefined;
  if (card?.type !== 'raw' || !card.data || typeof card.data !== 'object') return;
  const raw = event.raw as { token?: unknown } | undefined;
  if (typeof raw?.token !== 'string' || !raw.token) throw new Error('Delayed card response has no callback token');
  const data = card.data as Record<string, unknown>;
  // Card 1.0 requires an explicit recipient; Card 2.0 keeps the existing
  // update_multi policy from the authorized handler's complete card payload.
  const next = data.schema === '2.0' ? data : { ...data, open_ids: [event.operator.openId] };
  const result = await client.request<{ code?: number }>({
    method: 'POST', url: '/open-apis/interactive/v1/card/update',
    data: { token: raw.token, card: next },
  });
  if (result?.code !== 0) throw new Error(`Delayed card update not confirmed (${result?.code ?? 'missing code'})`);
}
