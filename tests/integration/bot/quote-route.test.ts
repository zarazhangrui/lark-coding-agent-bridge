import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { MessageRouteStore } from '../../../src/session/message-routes.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeChannel | undefined,
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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('reply-quote session routing', () => {
  it('routes a reply-quote of a past answer back to its source session', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    // Run 1 in chat A — a fresh conversation that records session `sess-a`.
    await h.channel.handlers.message?.(
      inbound({ messageId: 'om_a_1', chatId: 'oc_a', content: '@Bridge hello from A' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.channel.replies.length === 1);
    const replyId = h.channel.replies[0]!.messageId;
    // The bridge registered its reply → source scope in the ledger.
    await waitFor(async () => Boolean(await h.routes.lookup(replyId)), 1500);
    expect(await h.routes.lookup(replyId)).toMatchObject({
      scope: 'oc_a',
      sessionId: 'sess-a',
    });

    // Run 2 in chat B — a *different* chat — that reply-quotes A's answer.
    await h.channel.handlers.message?.(
      inbound({
        messageId: 'om_b_1',
        chatId: 'oc_b',
        content: '@Bridge follow up',
        replyTo: replyId,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    // The second run resumed chat A's session (sess-a) even though it arrived
    // in chat B — the quote routed it back to the source conversation.
    expect(h.agent.runOptions[1]?.sessionId).toBe('sess-a');
    expect(h.agent.runOptions[1]?.cwd).toBe(h.workspace);
  });

  it('leaves an un-quoted message on its own chat scope (no routing)', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      inbound({ messageId: 'om_a_1', chatId: 'oc_a', content: '@Bridge hello from A' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.channel.replies.length === 1);

    // A plain (non-reply) message in chat B must start its own session, not
    // resume chat A's — proving the routing is gated strictly on a quote hit.
    await h.channel.handlers.message?.(
      inbound({ messageId: 'om_b_1', chatId: 'oc_b', content: '@Bridge unrelated' }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();
  });
});

interface FakeChannel {
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  replies: Array<{ messageId: string; chatId: string }>;
  botIdentity: { openId: string; name: string };
  rawClient: unknown;
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void }): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
}

async function createHarness(): Promise<{
  tmp: TmpProfile;
  workspace: string;
  channel: FakeChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  routes: MessageRouteStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('quote-route-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_a', 'oc_b'], allowedUsers: ['ou_user'] },
  });
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const routes = new MessageRouteStore(join(tmp.profile, 'sessions.json.routes.json'));
  const agent = new FakeAgentAdapter({
    events: [
      [{ type: 'system', sessionId: 'sess-a' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), routes.flush()]);
    await tmp.cleanup();
  });
  return { tmp, workspace, channel, agent, sessions, workspaces, routes, profileConfig, controls };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  routes: MessageRouteStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    messageRoutes: h.routes,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeChannel(): FakeChannel {
  const handlers: FakeChannel['handlers'] = {};
  const replies: Array<{ messageId: string; chatId: string }> = [];
  let nextId = 0;
  return {
    handlers,
    replies,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: 'prior answer' }) },
        create_time: '1760000000000',
        sender: { id: 'ou_bot', sender_type: 'app' },
      },
    ]),
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
    async send(chatId) {
      const messageId = `om_reply_${++nextId}`;
      replies.push({ messageId, chatId });
      return { messageId };
    },
    async stream(chatId, input) {
      const messageId = `om_reply_${++nextId}`;
      replies.push({ messageId, chatId });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
      return { messageId };
    },
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

function inbound(input: {
  messageId: string;
  chatId: string;
  content: string;
  replyTo?: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: input.chatId,
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1760000001000,
    ...(input.replyTo
      ? { replyToMessageId: input.replyTo, rootId: input.replyTo, parentId: input.replyTo }
      : {}),
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
