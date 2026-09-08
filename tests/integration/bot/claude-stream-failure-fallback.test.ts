import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
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

import { startChannel } from '../../../src/bot/channel.js';

const NOTICE = '⚠️ 消息流式更新失败，本轮已结束，以下是完整回复：';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: Record<string, unknown>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A card/markdown update rejecting mid-run — an oversized-card 400, a rate
 * limit, a card sequence conflict, a network blip — used to reach nothing but
 * `log.fail` on the Claude path, leaving the user with a card frozen on
 * `streaming_mode: true` and no way to tell a finished run from a hung one.
 * Codex was already covered by its own dedicated final reply.
 */
describe('claude stream failure fallback', () => {
  it('delivers the accumulated answer when a card update fails mid-run', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: '先说结论：' },
          { type: 'text', delta: '答案是 42。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      failUpdateOnCall: 3,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_1', 'question'));
    await waitFor(() => h.channel.sent.some((s) => cardText(s.content).includes(NOTICE)));

    const fallback = h.channel.sent.find((s) => cardText(s.content).includes(NOTICE));
    expect(fallback, 'a fallback reply must reach the user').toBeDefined();
    // The whole point: the text the stream failed to deliver still arrives.
    expect(cardText(fallback?.content)).toContain('答案是 42。');
    // A finished run must not render as still-streaming.
    expect(streamingMode(fallback?.content)).toBe(false);
  });

  it('delivers the accumulated answer when a markdown update fails mid-run', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'markdown',
      events: [
        [
          { type: 'text', delta: '部分输出。' },
          { type: 'text', delta: '最终答案。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      failUpdateOnCall: 3,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_1', 'question'));
    await waitFor(() => h.channel.sent.some((s) => markdownOf(s.content).includes(NOTICE)));

    const fallback = h.channel.sent.find((s) => markdownOf(s.content).includes(NOTICE));
    expect(fallback, 'a fallback reply must reach the user').toBeDefined();
    expect(markdownOf(fallback?.content)).toContain('最终答案。');
  });

  it('does not add a fallback reply when the stream succeeds', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: '一切正常。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_1', 'question'));
    await waitFor(() => h.streamCalls() > 0);
    // Give any stray fallback a chance to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(h.channel.sent.some((s) => cardText(s.content).includes(NOTICE))).toBe(false);
  });

  it('leaves the Codex path on its own final reply, with no duplicate fallback', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'card',
      events: [
        [
          { type: 'text', delta: 'codex 输出。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      failUpdateOnCall: 3,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_1', 'question'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(h.channel.sent.some((s) => cardText(s.content).includes(NOTICE))).toBe(false);
  });
});

interface HarnessOptions {
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  agentKind?: 'claude' | 'codex';
  /**
   * 1-based index of the controller update call that should reject. The
   * producer's own opening update is call #1 and the first `processAgentStream`
   * flush is #2, so `3` fails once several deltas have accumulated — the case
   * where a real answer exists and would otherwise be lost.
   */
  failUpdateOnCall?: number;
}

async function createHarness(options: HarnessOptions = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  streamCalls: () => number;
}> {
  const tmp = await createTmpProfile('claude-stream-failure-fallback-');
  const workspace = await realpath(tmp.workspace);
  const agentKind = options.agentKind ?? 'claude';
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    codex: { binaryPath: '/usr/local/bin/codex' },
    ...(options.messageReply ? { preferences: { messageReply: options.messageReply } } : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: options.events ?? [],
  });
  let streamCalls = 0;
  const channel = createFakeLarkChannel(options, () => {
    streamCalls++;
  });
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
    streamCalls: () => streamCalls,
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

function createFakeLarkChannel(
  options: HarnessOptions,
  onStream: () => void,
): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  let updateCalls = 0;

  // Shared by both stream shapes: the Nth controller call rejects the way a
  // refused Feishu update does, which is what rejects `renderDone` upstream.
  const maybeFail = (): void => {
    updateCalls++;
    if (options.failUpdateOnCall && updateCalls >= options.failUpdateOnCall) {
      throw new Error('card update rejected by Feishu (simulated 400)');
    }
  };

  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
          },
        },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
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
    async send(chatId, content, options_) {
      sent.push({ chatId, content, options: options_ });
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      onStream();
      const cardInput = input as
        | { card?: { producer?: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void> } }
        | undefined;
      if (typeof cardInput?.card?.producer === 'function') {
        await cardInput.card.producer({
          async update() {
            maybeFail();
          },
        });
        return;
      }
      const mdInput = input as
        | { markdown?: (ctrl: { setContent(md: string): Promise<void> }) => Promise<void> }
        | undefined;
      if (typeof mdInput?.markdown === 'function') {
        await mdInput.markdown({
          async setContent() {
            maybeFail();
          },
        });
      }
    },
    async recallMessage() {},
    async addReaction() {
      return 'reaction_1';
    },
    async removeReaction() {},
  };
  return channel;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
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

/** Flatten a sent card back to text so assertions can read what the user saw. */
function cardText(content: unknown): string {
  const card = (content as { card?: unknown } | undefined)?.card;
  return card ? JSON.stringify(card) : '';
}

function streamingMode(content: unknown): boolean | undefined {
  const card = (content as { card?: { config?: { streaming_mode?: boolean } } } | undefined)?.card;
  return card?.config?.streaming_mode;
}

function markdownOf(content: unknown): string {
  return (content as { markdown?: string } | undefined)?.markdown ?? '';
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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
