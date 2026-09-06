import {
  normalize,
  type ApiMessageItem,
  type LarkChannel,
  type NormalizedMessage,
  type RawMessageEvent,
} from '@larksuite/channel';
import { readFile } from 'node:fs/promises';
import { log, reportMetric } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

const STATE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_OVERLAP_MS = 2 * 60_000;
const DEFAULT_MAX_LOOKBACK_MS = 10 * 60_000;
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_SEEN = 5_000;
const DEFAULT_MAX_CHATS = 20;
const MAX_FAILURE_BACKOFF_MS = 30 * 60_000;

interface ChatCheckpoint {
  chatType?: NormalizedMessage['chatType'];
  recoverAfter: number;
  lastScanAt: number;
  updatedAt: number;
}

interface PersistedState {
  version: typeof STATE_VERSION;
  chats: Record<string, ChatCheckpoint>;
  seen: Record<string, number>;
}

interface FailureState {
  attempts: number;
  retryAt: number;
}

export interface MessageRecoveryOptions {
  stateFile?: string;
  listMessages: (
    chatId: string,
    startMs: number,
    endMs: number,
    chatType?: NormalizedMessage['chatType'],
  ) => Promise<NormalizedMessage[]>;
  deliver: (message: NormalizedMessage, source: 'realtime' | 'recovery') => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  overlapMs?: number;
  maxLookbackMs?: number;
  settleMs?: number;
  seenTtlMs?: number;
  maxSeen?: number;
  maxChats?: number;
}

/**
 * REST catch-up for silent WebSocket gaps.
 *
 * The live event path and the catch-up path share the same persisted message-id
 * ledger. A short overlap makes the time cursor safe at second precision while
 * the ledger prevents overlap, reconnects, or late WS delivery from executing a
 * message twice.
 */
export class MessageRecovery {
  private readonly chats = new Map<string, ChatCheckpoint>();
  private readonly seen = new Map<string, number>();
  private readonly claims = new Set<string>();
  private readonly failures = new Map<string, FailureState>();
  private saving: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private scan?: Promise<void>;

  constructor(private readonly options: MessageRecoveryOptions) {}

  async load(): Promise<void> {
    if (!this.options.stateFile) return;
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return;
      const chats = isRecord(parsed.chats) ? parsed.chats : {};
      for (const [chatId, raw] of Object.entries(chats)) {
        const checkpoint = normalizeCheckpoint(raw);
        if (checkpoint) this.chats.set(chatId, checkpoint);
      }
      const seen = isRecord(parsed.seen) ? parsed.seen : {};
      for (const [messageId, timestamp] of Object.entries(seen)) {
        if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
          this.seen.set(messageId, timestamp);
        }
      }
      this.gc();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('message-recovery', 'state-load-failed', { err: errorText(error) });
      }
    }
  }

  async seedChat(
    chatId: string,
    chatType?: NormalizedMessage['chatType'],
  ): Promise<void> {
    if (!chatId || this.chats.has(chatId)) return;
    const now = this.now();
    this.chats.set(chatId, {
      ...(chatType ? { chatType } : {}),
      recoverAfter: now,
      lastScanAt: now,
      updatedAt: now,
    });
    this.gc();
    await this.persist();
  }

  async acceptRealtime(message: NormalizedMessage): Promise<boolean> {
    await this.ensureTracked(message.chatId, message.chatType);
    return this.accept(message, 'realtime');
  }

  start(): { stop(): void } {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.scanNow().catch((error) =>
          log.warn('message-recovery', 'scan-failed', { err: errorText(error) }),
        );
      }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
    void this.scanNow().catch((error) =>
      log.warn('message-recovery', 'scan-failed', { err: errorText(error) }),
    );
    return { stop: () => this.stop() };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  scanNow(): Promise<void> {
    if (this.scan) return this.scan;
    const current = this.scanAll().finally(() => {
      if (this.scan === current) this.scan = undefined;
    });
    this.scan = current;
    return current;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private async scanAll(): Promise<void> {
    for (const [chatId, checkpoint] of this.recentChats()) {
      const failure = this.failures.get(chatId);
      if (failure && failure.retryAt > this.now()) continue;
      try {
        await this.scanChat(chatId, checkpoint);
        this.failures.delete(chatId);
      } catch (error) {
        const attempts = (failure?.attempts ?? 0) + 1;
        const retryMs = Math.min(
          (this.options.intervalMs ?? DEFAULT_INTERVAL_MS) * 2 ** Math.min(attempts - 1, 6),
          MAX_FAILURE_BACKOFF_MS,
        );
        this.failures.set(chatId, { attempts, retryAt: this.now() + retryMs });
        log.warn('message-recovery', 'chat-scan-failed', {
          chatId,
          attempts,
          retryMs,
          err: errorText(error),
        });
      }
    }
  }

  private async scanChat(chatId: string, checkpoint: ChatCheckpoint): Promise<void> {
    const endMs = this.now() - (this.options.settleMs ?? DEFAULT_SETTLE_MS);
    if (endMs <= checkpoint.recoverAfter) return;
    const startMs = Math.max(
      checkpoint.lastScanAt - (this.options.overlapMs ?? DEFAULT_OVERLAP_MS),
      endMs - (this.options.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS),
      0,
    );
    const messages = await this.options.listMessages(
      chatId,
      startMs,
      endMs,
      checkpoint.chatType,
    );
    messages.sort((a, b) => a.createTime - b.createTime || a.messageId.localeCompare(b.messageId));
    let recovered = 0;
    for (const message of messages) {
      if (message.createTime < checkpoint.recoverAfter || message.createTime > endMs) continue;
      if (message.senderIsBot || message.senderType === 'app' || message.senderType === 'bot') continue;
      if (await this.accept(message, 'recovery')) recovered++;
    }
    checkpoint.lastScanAt = endMs;
    checkpoint.updatedAt = this.now();
    if (!checkpoint.chatType && messages[0]?.chatType) checkpoint.chatType = messages[0].chatType;
    this.gc();
    await this.persist();
    if (recovered > 0) {
      log.warn('message-recovery', 'messages-recovered', { chatId, count: recovered });
      reportMetric('im_message_recovered', recovered, { kind: 'rest-catchup' });
    }
  }

  private async accept(
    message: NormalizedMessage,
    source: 'realtime' | 'recovery',
  ): Promise<boolean> {
    if (this.seen.has(message.messageId) || this.claims.has(message.messageId)) {
      log.info('message-recovery', 'duplicate-dropped', {
        chatId: message.chatId,
        messageId: message.messageId,
        source,
      });
      reportMetric('im_message_duplicate', 1, { kind: source });
      return false;
    }
    this.claims.add(message.messageId);
    try {
      await this.options.deliver(message, source);
      this.seen.set(message.messageId, this.now());
      this.gc();
      await this.persist();
      return true;
    } finally {
      this.claims.delete(message.messageId);
    }
  }

  private async ensureTracked(
    chatId: string,
    chatType: NormalizedMessage['chatType'],
  ): Promise<void> {
    const existing = this.chats.get(chatId);
    if (existing) {
      existing.chatType = chatType;
      existing.updatedAt = this.now();
      return;
    }
    await this.seedChat(chatId, chatType);
  }

  private recentChats(): Array<[string, ChatCheckpoint]> {
    return [...this.chats.entries()]
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, this.options.maxChats ?? DEFAULT_MAX_CHATS);
  }

  private gc(): void {
    const now = this.now();
    const ttl = this.options.seenTtlMs ?? DEFAULT_SEEN_TTL_MS;
    for (const [messageId, timestamp] of this.seen) {
      if (now - timestamp > ttl) this.seen.delete(messageId);
    }
    const maxSeen = this.options.maxSeen ?? DEFAULT_MAX_SEEN;
    const newestSeen = [...this.seen.entries()].sort((a, b) => b[1] - a[1]);
    for (const [messageId] of newestSeen.slice(maxSeen)) this.seen.delete(messageId);

    const newestChats = [...this.chats.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [chatId] of newestChats.slice(this.options.maxChats ?? DEFAULT_MAX_CHATS)) {
      this.chats.delete(chatId);
      this.failures.delete(chatId);
    }
  }

  private persist(): Promise<void> {
    if (!this.options.stateFile) return Promise.resolve();
    this.saving = this.saving
      .then(() => {
        const state: PersistedState = {
          version: STATE_VERSION,
          chats: Object.fromEntries(this.chats),
          seen: Object.fromEntries(this.seen),
        };
        return writeFileAtomic(this.options.stateFile!, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((error: unknown) => {
        log.warn('message-recovery', 'state-persist-failed', { err: errorText(error) });
      });
    return this.saving;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function chatIdFromScope(scopeId: string): string | undefined {
  const chatId = scopeId.split(':', 1)[0];
  return chatId?.startsWith('oc_') ? chatId : undefined;
}

interface HistoryMessageItem extends Omit<ApiMessageItem, 'mentions' | 'sender'> {
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id?: string;
  deleted?: boolean;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
  };
  mentions?: Array<{
    key: string;
    id: string | { open_id?: string; user_id?: string; union_id?: string };
    id_type?: string;
    name?: string;
    tenant_key?: string;
  }>;
}

/** List and normalize user-visible messages from one chat through Feishu REST. */
export async function listRecoverableMessages(
  channel: LarkChannel,
  chatId: string,
  startMs: number,
  endMs: number,
  knownChatType?: NormalizedMessage['chatType'],
): Promise<NormalizedMessage[]> {
  const chatType = knownChatType ?? (await channel.getChatInfo(chatId)).chatType;
  const collected: HistoryMessageItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const response = await channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: String(Math.floor(startMs / 1000)),
        end_time: String(Math.ceil(endMs / 1000)),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        card_msg_content_type: 'user_card_content',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = (response as {
      data?: {
        items?: HistoryMessageItem[];
        messages?: HistoryMessageItem[];
        has_more?: boolean;
        page_token?: string;
      };
    }).data;
    collected.push(...(data?.items ?? data?.messages ?? []));
    pageToken = data?.has_more ? data.page_token : undefined;
    if (!pageToken) break;
  }

  const output: NormalizedMessage[] = [];
  for (const item of collected) {
    if (item.deleted || !item.message_id || !item.sender?.id) continue;
    const raw = historyItemToRaw(item, chatId, chatType);
    try {
      output.push(await normalize(raw, {
        botIdentity: channel.getBotIdentity(),
        stripBotMentions: true,
        includeRaw: true,
        fetchSubMessages: (messageId) => channel.fetchRawMessage(messageId),
      }));
    } catch (error) {
      log.warn('message-recovery', 'normalize-failed', {
        chatId,
        messageId: item.message_id,
        err: errorText(error),
      });
    }
  }
  return output;
}

function historyItemToRaw(
  item: HistoryMessageItem,
  chatId: string,
  chatType: NormalizedMessage['chatType'],
): RawMessageEvent {
  const senderId = item.sender?.id ?? '';
  const senderIdType = item.sender?.id_type;
  const mappedSenderId = senderIdType === 'user_id'
    ? { user_id: senderId }
    : senderIdType === 'union_id'
      ? { union_id: senderId }
      : { open_id: senderId };
  return {
    sender: {
      sender_id: mappedSenderId,
      sender_type: item.sender?.sender_type,
      tenant_key: item.sender?.tenant_key,
    },
    message: {
      message_id: item.message_id ?? '',
      root_id: item.root_id,
      parent_id: item.parent_id,
      thread_id: item.thread_id,
      create_time: item.create_time === undefined ? undefined : String(item.create_time),
      chat_id: item.chat_id || chatId,
      chat_type: chatType,
      message_type: item.msg_type ?? 'text',
      content: item.body?.content ?? '',
      mentions: item.mentions?.map((mention) => ({
        key: mention.key,
        id: typeof mention.id === 'string'
          ? mention.id_type === 'user_id'
            ? { user_id: mention.id }
            : mention.id_type === 'union_id'
              ? { union_id: mention.id }
              : { open_id: mention.id }
          : mention.id,
        name: mention.name,
        tenant_key: mention.tenant_key,
      })),
    },
  };
}

function normalizeCheckpoint(input: unknown): ChatCheckpoint | undefined {
  if (!isRecord(input)) return undefined;
  const { chatType, recoverAfter, lastScanAt, updatedAt } = input;
  if (
    typeof recoverAfter !== 'number' ||
    typeof lastScanAt !== 'number' ||
    typeof updatedAt !== 'number' ||
    ![recoverAfter, lastScanAt, updatedAt].every(Number.isFinite) ||
    (chatType !== undefined && chatType !== 'p2p' && chatType !== 'group')
  ) return undefined;
  return {
    ...(chatType ? { chatType } : {}),
    recoverAfter,
    lastScanAt,
    updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
