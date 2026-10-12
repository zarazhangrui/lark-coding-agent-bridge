import type { LarkChannel } from '@larksuite/channel';
import type { DocumentClient } from './task-documents';

/** The SDK's updateCard resolves on nonzero business codes too. Do not report
 * successful synchronization until the platform explicitly accepts the patch. */
export function proactiveChannel(channel: Pick<LarkChannel, 'send' | 'rawClient'>): Pick<LarkChannel, 'send' | 'updateCard'> {
  return {
    send: channel.send.bind(channel),
    async updateCard(messageId, card) {
      const result = await (channel.rawClient as DocumentClient).request<{ code?: number }>({
        method: 'PATCH', url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        data: { content: JSON.stringify(card) },
      });
      if (result?.code !== 0) throw new Error(`Card synchronization not confirmed (${result?.code ?? 'missing code'})`);
    },
  };
}
