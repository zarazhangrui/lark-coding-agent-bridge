import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { sendFinalReply, startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  cardUpdates: Array<{ messageId: string; card: object }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('delivers a fallback when stream failure arrives after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
    await waitFor(
      () => markdownForReply(h.channel, 'om_first')?.includes('流式消息更新失败') === true,
    );
  }, 10_000);

  it('falls back to a visible markdown reply when card updates fail', async () => {
    let streamCalls = 0;
    const h = await createHarness({
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: `start ${'x'.repeat(20_000)} end-marker` },
          { type: 'done', terminationReason: 'normal' },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        streamCalls += 1;
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              update(next: object | ((current: object) => object)): Promise<void>;
              readonly messageId?: string;
            }) => Promise<void>;
          };
        }).card?.producer;
        if (producer) {
          await producer({
            // The real SDK resolves update() after scheduling a patch. The
            // asynchronous patch failure is surfaced by the stream terminal.
            update: vi.fn(async () => {}),
            messageId: 'om_stream_card',
          });
        }
        if (streamCalls > 1) return;
        await new Promise((resolve) => setTimeout(resolve, 3200));
        throw new Error('230099 / 11310: element exceeds the limit');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(
      () => latestMarkdownContent(h.channel)?.includes('飞书卡片更新失败') === true,
      6000,
    );

    const fallback = lastMarkdown(h.channel);
    expect(fallback).toContain('start ');
    expect(fallback).toContain('回复过长');
    expect(fallback).toContain('end-marker');
    expect(h.channel.cardUpdates.at(-1)?.messageId).toBe('om_stream_card');
    expect(JSON.stringify(h.channel.cardUpdates.at(-1)?.card)).toContain('最终回复已改发');

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);
  }, 10_000);

  it('preflights over-budget cards and sends markdown without an invalid update', async () => {
    const update = vi.fn(async (_next: object | ((current: object) => object)) => {});
    const tables = Array.from(
      { length: 4 },
      (_, i) => `table ${i}\n\n| key | value |\n| --- | --- |\n| a | b |`,
    ).join('\n\n');
    const h = await createHarness({
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: tables },
          { type: 'done', terminationReason: 'normal' },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              update(next: object | ((current: object) => object)): Promise<void>;
              readonly messageId?: string;
            }) => Promise<void>;
          };
        }).card?.producer;
        if (producer) await producer({ update, messageId: 'om_preflight_card' });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(
      () => latestMarkdownContent(h.channel)?.includes('飞书卡片更新失败') === true,
    );

    expect(
      update.mock.calls.some((call) => JSON.stringify(call[0]).includes('| --- |')),
    ).toBe(false);
    expect(lastMarkdown(h.channel)).toContain('table 0');
    expect(JSON.stringify(h.channel.cardUpdates.at(-1)?.card)).toContain('最终回复已改发');

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);
  });

  it('falls back to a visible markdown reply when markdown stream updates fail', async () => {
    let streamCalls = 0;
    const h = await createHarness({
      messageReply: 'markdown',
      events: [
        [
          { type: 'text', delta: `start ${'x'.repeat(20_000)} end-marker` },
          { type: 'done', terminationReason: 'normal' },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        streamCalls += 1;
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          // @larksuite/channel 0.3.x swallows asynchronous markdown patch
          // errors and records them on the controller instead of rejecting.
          const ctrl = {
            streamingFailed: false,
            setContent: vi.fn(async () => {}),
          };
          await producer(ctrl);
          if (streamCalls > 1) return;
          await new Promise((resolve) => setTimeout(resolve, 3200));
          ctrl.streamingFailed = true;
        }
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(
      () => latestMarkdownContent(h.channel)?.includes('飞书流式消息更新失败') === true,
      6000,
    );

    const fallback = lastMarkdown(h.channel);
    expect(fallback).toContain('start ');
    expect(fallback).toContain('回复过长');
    expect(fallback).toContain('end-marker');

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);
  }, 10_000);

  it('applies card preflight and fallback to non-stream final replies', async () => {
    const tables = Array.from(
      { length: 4 },
      (_, i) => `table ${i}\n\n| key | value |\n| --- | --- |\n| a | b |`,
    ).join('\n\n');
    const h = await createHarness();

    await sendFinalReply({
      channel: h.channel as unknown as LarkChannel,
      chatId: 'oc_dm',
      scope: 'oc_dm',
      state: stateFrom([
        { type: 'text', delta: tables },
        { type: 'done', terminationReason: 'normal' },
      ]),
      replyMode: 'card',
      sendOpts: { replyTo: 'om_final' },
      cardRenderOptions: {},
    });

    expect(lastMarkdown(h.channel)).toContain('飞书卡片更新失败');
    expect(lastMarkdown(h.channel)).toContain('table 0');
    expect(h.channel.sent.some((entry) => 'card' in (entry.content as object))).toBe(false);
  });

  it('detects swallowed SDK failures in non-stream markdown final replies', async () => {
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return;
        const ctrl = { streamingFailed: false, setContent: vi.fn(async () => {}) };
        await producer(ctrl);
        ctrl.streamingFailed = true;
      },
    });

    await sendFinalReply({
      channel: h.channel as unknown as LarkChannel,
      chatId: 'oc_dm',
      scope: 'oc_dm',
      state: stateFrom([
        { type: 'text', delta: 'final answer' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_final' },
      cardRenderOptions: {},
    });

    expect(lastMarkdown(h.channel)).toBe('final answer');
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  messageReply?: 'card' | 'markdown' | 'text';
  events?: FakeAgentEvents;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    preferences: {
      ...baseProfileConfig.preferences,
      ...(options.messageReply
        ? { messageReply: options.messageReply, messageReplyMigrated: true }
        : {}),
    },
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardUpdates: FakeLarkChannel['cardUpdates'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    cardUpdates,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async updateCard(messageId, card) {
      cardUpdates.push({ messageId, card });
    },
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = latestMarkdownContent(channel);
  expect(content).toBeTypeOf('string');
  return content ?? '';
}

function latestMarkdownContent(channel: FakeLarkChannel): string | undefined {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  return content?.markdown;
}

function markdownForReply(channel: FakeLarkChannel, replyTo: string): string | undefined {
  const entry = channel.sent.find((item) =>
    (item.options as { replyTo?: string } | undefined)?.replyTo === replyTo,
  );
  return (entry?.content as { markdown?: string } | undefined)?.markdown;
}

function stateFrom(events: readonly AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
