import type { NormalizedMessage } from '@larksuite/channel';
import { writeFile } from 'node:fs/promises';
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

const CHAT = 'oc_group';
/** The inbox is swept on a 2s timer; give a wake room to land plus slack. */
const WAKE_WAIT_MS = 5_000;
const QUIET_MS = 400;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * 后台回执 — a job that outlived its run writes a line, and the bridge both
 * shows it and hands the agent another round.
 *
 * The reason this is an integration test: the old way of doing this (the agent
 * sending a Feishu message as the user, which came back through intake) only
 * worked in a DM, and only because a p2p message skips the @-mention gate.
 * These run in a **group**, which is precisely where that accident never fired.
 */
describe('wake continuation', () => {
  it('a detached job wakes the agent for another round — in a group', async () => {
    // Round 1 writes a wake, as a detached job would. Round 2 doesn't.
    const h = await createHarness(['06-26 打包完成，1.29 GB 已上传', undefined]);
    await startTestBridge(h);

    await h.send('把三天的手术包传到 NAS');
    await h.waitForRuns(2, WAKE_WAIT_MS);

    expect(h.agent.prompts).toHaveLength(2);
    // The wake reaches the agent as its own turn, marked as coming from the job.
    expect(h.agent.prompts[1]).toContain('后台回执');
    expect(h.agent.prompts[1]).toContain('06-26 打包完成');
    // …and the user saw it, posted by the bot rather than as themselves.
    expect(h.texts().some((t) => t.includes('🔔') && t.includes('06-26 打包完成'))).toBe(true);
  }, 15_000);

  it('hands the agent a usable path in bridge_context', async () => {
    const h = await createHarness([undefined]);
    await startTestBridge(h);

    await h.send('随便问一句');
    await h.settleAt(1);

    const prompt = h.agent.prompts[0] ?? '';
    expect(prompt).toContain('wakePrefix');
    // Under the profile directory, not a shared tmp location: two bridges
    // sharing an inbox would deliver each other's wakes.
    const prefix = /"wakePrefix":"([^"\\]+)"/.exec(prompt)?.[1];
    expect(prefix).toBeTruthy();
    expect(prefix).toContain(h.tmp.profile);
  });

  it('does not start extra rounds when nothing writes a wake', async () => {
    const h = await createHarness([undefined, undefined]);
    await startTestBridge(h);

    await h.send('随便问一句');
    await h.settleAt(1);
    // Long enough for more than one sweep of an inbox that has nothing in it.
    await h.idle(WAKE_WAIT_MS);

    expect(h.agent.prompts).toHaveLength(1);
  }, 15_000);

  it('gives a chat and its topics separate inboxes', async () => {
    const h = await createHarness([undefined, undefined]);
    await startTestBridge(h);

    await h.send('第一句');
    await h.settleAt(1);
    await h.send('话题里一句', 'omt_1');
    await h.settleAt(2);

    const paths = h.agent.prompts.map((p) => /"wakePrefix":"([^"\\]+)"/.exec(p)?.[1]);
    // A topic's scope is `chatId:threadId`. Sharing the chat's inbox would
    // deliver a topic job's report into the wrong conversation.
    expect(paths[0]).toBeTruthy();
    expect(paths[1]).toBeTruthy();
    expect(paths[0]).not.toBe(paths[1]);
  });
});

/**
 * Round N writes the script's line (if any) to the `wakeFile` the prompt gave
 * it — what a real detached job does, minus the detaching.
 */
class ScriptedAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly prompts: string[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #round = 0;

  constructor(private readonly script: Array<string | undefined>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.prompts.push(opts.prompt);
    const round = ++this.#round;
    const note = this.script[round - 1];
    // Read the prefix out of the prompt exactly as a real agent has to. Prompt
    // sections are JSON-encoded, so the path arrives with escaped quotes.
    const prefix = /"wakePrefix":"([^"\\]+)"/.exec(opts.prompt)?.[1];
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: `第 ${round} 轮进度。` };
      if (note !== undefined && prefix) {
        // A unique name, then `mv` into place — the form the system prompt
        // documents. A half-written `.wake` must never be swept.
        const tmp = `${prefix}.r${round}.tmp`;
        await writeFile(tmp, note, 'utf8');
        const { rename } = await import('node:fs/promises');
        await rename(tmp, `${prefix}.r${round}.wake`);
      }
      yield { type: 'done', terminationReason: 'normal' };
    })();
    return {
      runId: opts.runId,
      events,
      stop: async () => {},
      waitForExit: async () => true,
    };
  }
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: ScriptedAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  appPaths: { secretsFile: string; keystoreSaltFile: string; mediaDir: string };
  send: (content: string, threadId?: string) => Promise<void>;
  settleAt: (n: number) => Promise<void>;
  waitForRuns: (n: number, timeoutMs?: number) => Promise<void>;
  idle: (ms: number) => Promise<void>;
  texts: () => string[];
}

async function createHarness(script: Array<string | undefined>): Promise<Harness> {
  const tmp = await createTmpProfile('wake-continuation-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: [CHAT] },
    preferences: { messageReply: 'markdown', cotMessages: 'off' },
  });
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new ScriptedAgent(script);
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  const idle = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const send = async (content: string, threadId?: string): Promise<void> => {
    await channel.handlers.message?.(
      message(`om_${channel.sent.length + 1}`, content, threadId),
    );
  };
  const waitForRuns = async (n: number, timeoutMs = 3_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (agent.prompts.length < n && Date.now() < deadline) await idle(20);
  };
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls: createControls(profileConfig),
    appPaths: {
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, 'salt'),
      // The wake directory is derived from this — see `wakeDirFor`.
      mediaDir: join(tmp.profile, 'media'),
    },
    send,
    waitForRuns,
    idle,
    settleAt: async (n) => {
      await waitForRuns(n);
      await idle(QUIET_MS);
    },
    texts: () =>
      channel.sent.map((s) => {
        const content = s.content as { markdown?: string; text?: string };
        return content.markdown ?? content.text ?? '';
      }),
  };
}

async function startTestBridge(h: Harness): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: h.appPaths,
  });
  cleanups.push(() => bridge.disconnect());
}

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown }>;
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
  return {
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
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      const cardInput = input as
        | { card?: { producer?: (ctrl: { update(c: unknown): Promise<void> }) => Promise<void> } }
        | undefined;
      if (typeof cardInput?.card?.producer === 'function') {
        await cardInput.card.producer({ async update() {} });
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

function message(messageId: string, content: string, threadId?: string): NormalizedMessage {
  return {
    messageId,
    chatId: CHAT,
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    // The bot was addressed; the point of these tests is what happens *after*
    // that, in a chat where an un-@'d message would have been dropped.
    mentionedBot: true,
    ...(threadId ? { threadId } : {}),
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}
