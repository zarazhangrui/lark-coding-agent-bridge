import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import {
  DEFAULT_TOOL_STALL_GRACE_MINUTES,
  DEFAULT_TOOL_STALL_TIMEOUT_MINUTES,
} from '../../../src/config/schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
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
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

const MINUTE = 60_000;
const DEBOUNCE_MS = 600;

// Derived from the shipped defaults rather than restated, so raising them (as
// 20 + 10 → 60 + 60 did) can't leave these tests asserting a behaviour the
// bridge no longer has.
const WARN = DEFAULT_TOOL_STALL_TIMEOUT_MINUTES;
const GRACE = DEFAULT_TOOL_STALL_GRACE_MINUTES;

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * The gap this watchdog exists to close: the idle watchdog deliberately pauses
 * while a tool call is outstanding, so a Bash / MCP / OAuth subprocess that
 * never returns leaves the run with no timeout at all — card streaming forever,
 * pool slot never released, and no way for the user to tell it apart from a
 * long-but-healthy tool.
 */
describe('tool stall watchdog', () => {
  it('warns on the card without killing a tool that is merely slow', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await h.agent.emit({ type: 'tool_use', id: 't1', name: 'Bash', input: {} });

    // Threshold reached: the run is flagged, but deliberately left alone.
    await vi.advanceTimersByTimeAsync(WARN * MINUTE + 100);

    expect(h.lastCardJson()).toContain(`工具 Bash 已 ${WARN} 分钟无输出`);
    expect(h.agent.stopped).toBe(false);
  });

  it('stops the run only after the grace window also passes', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await h.agent.emit({ type: 'tool_use', id: 't1', name: 'Bash', input: {} });

    await vi.advanceTimersByTimeAsync(WARN * MINUTE + 100);
    expect(h.agent.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(GRACE * MINUTE + 100);
    expect(h.agent.stopped).toBe(true);
  });

  it('rewinds both stages when the slow tool finally reports back', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await h.agent.emit({ type: 'tool_use', id: 't1', name: 'Bash', input: {} });

    await vi.advanceTimersByTimeAsync(WARN * MINUTE + 100);
    expect(h.lastCardJson()).toContain('无输出');

    // A legitimately long tool returning must clear the warning outright.
    await h.agent.emit({ type: 'tool_result', id: 't1', output: 'done', isError: false });
    await h.agent.emit({ type: 'text', delta: '继续。' });
    expect(h.lastCardJson()).not.toContain('无输出');

    // …and buy the run a full fresh window rather than a partial one.
    await vi.advanceTimersByTimeAsync(WARN * MINUTE - 200);
    expect(h.agent.stopped).toBe(false);
  });

  it('fires even when no tool is in flight, unlike the idle watchdog', async () => {
    // The idle watchdog is off by default; a run that goes silent without ever
    // calling a tool would otherwise also hang forever.
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await h.agent.emit({ type: 'text', delta: '想一下…' });

    await vi.advanceTimersByTimeAsync((WARN + GRACE) * MINUTE + 200);
    expect(h.agent.stopped).toBe(true);
  });

  it('stays out of the way entirely when disabled', async () => {
    const h = await createHarness({ toolStallTimeoutMinutes: 0 });
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await h.agent.emit({ type: 'tool_use', id: 't1', name: 'Bash', input: {} });

    await vi.advanceTimersByTimeAsync(4 * 60 * MINUTE);
    expect(h.agent.stopped).toBe(false);
    expect(h.lastCardJson()).not.toContain('无输出');
  });

  it('does not flag a run that keeps producing events', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await h.channel.handlers.message?.(message('om_1', 'go'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

    for (let i = 0; i < 5; i++) {
      await h.agent.emit({ type: 'text', delta: `第 ${i} 段。` });
      await vi.advanceTimersByTimeAsync(15 * MINUTE);
    }

    expect(h.agent.stopped).toBe(false);
    expect(h.lastCardJson()).not.toContain('无输出');
  });
});

/**
 * An agent whose event stream is driven by the test: `emit` pushes one event
 * and yields to the microtask queue so the consumer processes it, and the
 * stream stays open until `stop()` — which is what a wedged tool looks like.
 */
class ControllableAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  stopped = false;
  botIdentity: AgentBotIdentity | undefined;
  #push: ((evt: AgentEvent) => void) | undefined;
  #end: (() => void) | undefined;
  #started: Promise<void>;
  #markStarted!: () => void;

  constructor() {
    this.#started = new Promise<void>((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async emit(evt: AgentEvent): Promise<void> {
    await this.#started;
    this.#push?.(evt);
    // Let the stream consumer drain the queue and re-arm its timers before the
    // test advances the clock again.
    await Promise.resolve();
    await Promise.resolve();
  }

  run(opts: AgentRunOptions): AgentRun {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    this.#push = (evt) => {
      queue.push(evt);
      wake?.();
    };
    this.#end = () => {
      ended = true;
      wake?.();
    };
    const self = this;
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      self.#markStarted();
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = undefined;
            resolve();
          };
        });
      }
    })();
    return {
      runId: opts.runId,
      events,
      stop: async () => {
        this.stopped = true;
        this.#end?.();
      },
      waitForExit: async () => true,
    };
  }
}

async function createHarness(
  preferences: Record<string, unknown> = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: ControllableAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  lastCardJson: () => string;
}> {
  const tmp = await createTmpProfile('tool-stall-watchdog-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card', ...preferences },
  });
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new ControllableAgent();
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
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
    controls: createControls(profileConfig),
    lastCardJson: () => JSON.stringify(channel.cardUpdates.at(-1) ?? {}),
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: ControllableAgent;
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

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown }>;
  cardUpdates: unknown[];
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

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardUpdates: unknown[] = [];
  return {
    handlers,
    sent,
    cardUpdates,
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
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content) {
      sent.push({ chatId, content });
      const card = (content as { card?: unknown } | undefined)?.card;
      if (card) cardUpdates.push(card);
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      const cardInput = input as
        | { card?: { producer?: (ctrl: { update(c: unknown): Promise<void> }) => Promise<void> } }
        | undefined;
      if (typeof cardInput?.card?.producer === 'function') {
        await cardInput.card.producer({
          async update(card) {
            cardUpdates.push(card);
          },
        });
      }
    },
    async recallMessage() {},
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
  };
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
