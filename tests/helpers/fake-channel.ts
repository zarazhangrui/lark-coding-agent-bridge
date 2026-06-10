export interface FakeChannelMessage {
  chatId: string;
  content: unknown;
  options: unknown;
}

export interface FakeChannelStream {
  chatId: string;
  input: unknown;
  options: unknown;
  cardUpdates: unknown[];
  markdownContents: string[];
}

export interface FakeRawClientRequest {
  method: string;
  params: unknown;
}

export interface FakeChannel {
  readonly sent: FakeChannelMessage[];
  readonly streams: FakeChannelStream[];
  /**
   * Maps a messageId to the `thread_id` that `fetchRawMessage` should report
   * for it — mirrors the raw `im.v1.message.get` items[0].thread_id that the
   * card dispatcher reads to scope topic-group clicks. Empty by default.
   */
  readonly rawThreadIds: Map<string, string>;
  fetchRawMessage(messageId: string): Promise<Array<{ thread_id?: string }>>;
  readonly rawClient: {
    readonly requests: FakeRawClientRequest[];
    request(method: string, params: unknown): Promise<unknown>;
    readonly cardkit: {
      readonly v1: {
        readonly card: {
          create(params: unknown): Promise<unknown>;
          update(params: unknown): Promise<unknown>;
        };
      };
    };
    readonly im: {
      readonly v1: {
        readonly message: {
          create(params: unknown): Promise<unknown>;
          reply(params: unknown): Promise<unknown>;
          delete(params: unknown): Promise<unknown>;
        };
      };
    };
  };
  createCard(cardJson: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

export function createFakeChannel(): FakeChannel {
  const sent: FakeChannelMessage[] = [];
  const streams: FakeChannelStream[] = [];
  const requests: FakeRawClientRequest[] = [];
  const rawThreadIds = new Map<string, string>();
  const cardById = new Map<string, unknown>();
  let nextCard = 1;
  let nextMessage = 1;

  const pushManagedCardMessage = (params: unknown, fallbackChatId: string): { message_id: string } => {
    requests.push({ method: 'im.v1.message.create', params });
    const card = resolveReferencedCard(params);
    sent.push({
      chatId: extractReceiveId(params) ?? fallbackChatId,
      content: card ? { card } : params,
      options: undefined,
    });
    return { message_id: `om_fake_${nextMessage++}` };
  };

  return {
    sent,
    streams,
    rawThreadIds,
    async fetchRawMessage(messageId: string): Promise<Array<{ thread_id?: string }>> {
      const threadId = rawThreadIds.get(messageId);
      return [threadId ? { thread_id: threadId } : {}];
    },
    rawClient: {
      requests,
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({ method, params });
        return undefined;
      },
      cardkit: {
        v1: {
          card: {
            async create(params: unknown): Promise<unknown> {
              requests.push({ method: 'cardkit.v1.card.create', params });
              const cardId = `card_fake_${nextCard++}`;
              cardById.set(cardId, extractCardJson(params));
              return { data: { card_id: cardId } };
            },
            async update(params: unknown): Promise<unknown> {
              requests.push({ method: 'cardkit.v1.card.update', params });
              return {};
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async create(params: unknown): Promise<unknown> {
              return { data: pushManagedCardMessage(params, '') };
            },
            async reply(params: unknown): Promise<unknown> {
              return { data: pushManagedCardMessage(params, '') };
            },
            async delete(params: unknown): Promise<unknown> {
              requests.push({ method: 'im.v1.message.delete', params });
              return {};
            },
          },
        },
      },
    },
    async createCard(cardJson: unknown): Promise<{ cardId: string }> {
      const cardId = `card_fake_${nextCard++}`;
      cardById.set(cardId, cardJson);
      return { cardId };
    },
    async updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void> {
      requests.push({ method: 'cardkit.v1.card.update', params: { cardId, cardJson, sequence } });
    },
    async send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }> {
      // Resolve a `{ cardId }` reference back to the card JSON so assertions
      // can read the rendered card content (matching the legacy send shape).
      const cardId = (content as { cardId?: unknown } | undefined)?.cardId;
      const resolved =
        typeof cardId === 'string' && cardById.has(cardId)
          ? { card: cardById.get(cardId) }
          : content;
      sent.push({ chatId, content: resolved, options });
      return { messageId: `om_fake_${nextMessage++}` };
    },
    async stream(chatId: string, input: unknown, options?: unknown): Promise<void> {
      const record: FakeChannelStream = {
        chatId,
        input,
        options,
        cardUpdates: [],
        markdownContents: [],
      };
      streams.push(record);

      if (isCardStreamInput(input)) {
        await input.card.producer({
          update: async (card: unknown): Promise<void> => {
            record.cardUpdates.push(card);
          },
        });
      }

      if (isMarkdownStreamInput(input)) {
        await input.markdown({
          setContent: async (markdown: string): Promise<void> => {
            record.markdownContents.push(markdown);
          },
        });
      }
    },
  };

  function resolveReferencedCard(params: unknown): unknown | undefined {
    const content = (params as { data?: { content?: unknown } } | undefined)?.data?.content;
    if (typeof content !== 'string') return undefined;
    try {
      const parsed = JSON.parse(content) as { data?: { card_id?: string } };
      return parsed.data?.card_id ? cardById.get(parsed.data.card_id) : undefined;
    } catch {
      return undefined;
    }
  }
}

function extractCardJson(params: unknown): unknown {
  const data = (params as { data?: { data?: unknown } } | undefined)?.data?.data;
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function extractReceiveId(params: unknown): string | undefined {
  const receiveId = (params as { data?: { receive_id?: unknown } } | undefined)?.data?.receive_id;
  return typeof receiveId === 'string' ? receiveId : undefined;
}

interface FakeCardController {
  update(card: unknown): Promise<void>;
}

interface FakeMarkdownController {
  setContent(markdown: string): Promise<void>;
}

interface FakeCardStreamInput {
  card: {
    initial: unknown;
    producer(ctrl: FakeCardController): Promise<void> | void;
  };
}

interface FakeMarkdownStreamInput {
  markdown(ctrl: FakeMarkdownController): Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCardStreamInput(value: unknown): value is FakeCardStreamInput {
  if (!isRecord(value) || !isRecord(value.card)) return false;
  return typeof value.card.producer === 'function';
}

function isMarkdownStreamInput(value: unknown): value is FakeMarkdownStreamInput {
  return isRecord(value) && typeof value.markdown === 'function';
}
