import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { t } from '../i18n';

export interface KnownChat {
  id: string;
  name: string;
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  try {
    const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
    const chats: KnownChat[] = summaries.map((c) => ({
      id: c.id,
      name: c.name || t('common.unnamed'),
    }));
    log.info('lark-info', 'chats-fetched', { count: chats.length });
    return chats;
  } catch (err) {
    log.warn('lark-info', 'chats-fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
