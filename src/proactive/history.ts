import type { LarkChannel } from '@larksuite/channel';
import type { ObserverMessage } from './types';

const PAGE_SIZE = 50;
const MAX_PAGES = 4;

interface ApiMessageItem {
  message_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  chat_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    sender_name?: string;
  };
  body?: { content?: string };
  mentions?: Array<{ id?: string; name?: string; user_name?: string }>;
}

interface MessageListResponse {
  code?: number;
  msg?: string;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: ApiMessageItem[];
  };
}

type HistoryClient = {
  im: {
    v1: {
      message: {
        list(input: {
          params: {
            container_id_type: 'chat' | 'thread';
            container_id: string;
            start_time: string;
            sort_type: 'ByCreateTimeAsc';
            page_size: number;
            page_token?: string;
            only_thread_root_messages?: boolean;
            with_sender_name?: boolean;
          };
        }): Promise<MessageListResponse>;
      };
    };
  };
};

export interface ProactiveHistorySource {
  listChatRoots(chatId: string, since: number): Promise<ObserverMessage[]>;
  listThread(chatId: string, threadId: string, since: number): Promise<ObserverMessage[]>;
}

/**
 * Read-side recovery for Feishu's push channel.
 *
 * Long connections are a notification path, not a durable queue: a process can
 * look connected while a message event is missed. The history API is the
 * durable source of truth, so the proactive observer periodically reconciles
 * allowlisted roots and any thread that owns a pending follow-up.
 */
export class LarkProactiveHistorySource implements ProactiveHistorySource {
  constructor(
    private readonly client: HistoryClient,
    private readonly botOpenId: () => string | undefined,
  ) {}

  listChatRoots(chatId: string, since: number): Promise<ObserverMessage[]> {
    return this.list('chat', chatId, chatId, since, true);
  }

  listThread(chatId: string, threadId: string, since: number): Promise<ObserverMessage[]> {
    return this.list('thread', threadId, chatId, since, false);
  }

  private async list(
    containerType: 'chat' | 'thread',
    containerId: string,
    chatId: string,
    since: number,
    rootsOnly: boolean,
  ): Promise<ObserverMessage[]> {
    const messages: ObserverMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.client.im.v1.message.list({
        params: {
          container_id_type: containerType,
          container_id: containerId,
          start_time: String(Math.max(0, Math.floor(since / 1_000))),
          sort_type: 'ByCreateTimeAsc',
          page_size: PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
          ...(rootsOnly ? { only_thread_root_messages: true } : {}),
          with_sender_name: true,
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Feishu message history failed (${response.code}): ${response.msg ?? 'unknown'}`);
      }
      for (const item of response.data?.items ?? []) {
        const normalized = normalizeItem(item, chatId, this.botOpenId());
        if (normalized) messages.push(normalized);
      }
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    return messages;
  }
}

export function createLarkProactiveHistorySource(channel: LarkChannel): ProactiveHistorySource {
  return new LarkProactiveHistorySource(
    channel.rawClient as unknown as HistoryClient,
    () => channel.botIdentity?.openId,
  );
}

function normalizeItem(
  item: ApiMessageItem,
  fallbackChatId: string,
  botOpenId: string | undefined,
): ObserverMessage | undefined {
  if (
    (item.msg_type !== 'text' && item.msg_type !== 'post') ||
    item.sender?.sender_type !== 'user' ||
    !item.message_id ||
    !item.sender.id ||
    !item.body?.content
  ) {
    return undefined;
  }
  if (botOpenId && item.mentions?.some((mention) => mention.id === botOpenId)) {
    return undefined;
  }
  let text: string | undefined;
  try {
    const body = JSON.parse(item.body.content) as unknown;
    text = item.msg_type === 'text' ? extractTextMessage(body) : extractPostMessage(body);
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  const createTime = Number(item.create_time);
  if (!Number.isFinite(createTime)) return undefined;
  const mentions = (item.mentions ?? [])
    .filter((mention) => Boolean(mention.id) && mention.id !== botOpenId)
    .map((mention) => ({
      id: mention.id!,
      ...(mention.name ?? mention.user_name
        ? { name: mention.name ?? mention.user_name }
        : {}),
    }));
  return {
    messageId: item.message_id,
    chatId: item.chat_id ?? fallbackChatId,
    ...(item.thread_id ? { threadId: item.thread_id } : {}),
    senderId: item.sender.id,
    ...(item.sender.sender_name ? { senderName: item.sender.sender_name } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    text,
    createTime,
  };
}

function extractTextMessage(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.text !== 'string') return undefined;
  return nonEmpty(body.text);
}

function extractPostMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const localized = Object.values(body).find(
    (value) => isRecord(value) && Array.isArray(value.content),
  );
  const post = isRecord(localized) ? localized : body;
  if (!Array.isArray(post.content)) return undefined;

  const lines: string[] = [];
  if (typeof post.title === 'string' && post.title.trim()) lines.push(post.title.trim());
  for (const row of post.content) {
    if (!Array.isArray(row)) continue;
    const line = row
      .map((element) => {
        if (!isRecord(element)) return '';
        if (typeof element.text === 'string') return element.text;
        if (element.tag === 'at' && typeof element.user_name === 'string') {
          return `@${element.user_name}`;
        }
        return '';
      })
      .join('')
      .trim();
    if (line) lines.push(line);
  }
  return nonEmpty(lines.join('\n'));
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
