import type { NormalizedMessage } from '@larksuite/channel';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { TopicContextStore } from '../../../src/bot/topic-context.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  streamCalls: Array<{ input: unknown; options?: unknown }>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('topic message quote handling', () => {
  it('does not quote the topic root when a user directly mentions the bot inside the topic', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(prompt).not.toContain('topic root content');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('keeps regular group reply quotes as quoted context', async () => {
    const h = await createHarness({
      chatMode: 'group',
      quotedMessages: {
        om_quote_target: 'regular quoted content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_group_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 看这条',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('regular quoted content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_quote_target',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('keeps non-root reply quotes in topic chats', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_topic_parent: 'topic parent content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_reply',
        rootId: 'om_topic_root',
        parentId: 'om_topic_parent',
        threadId: 'omt_topic',
        content: '@Bridge 看父消息',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('topic parent content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_topic_parent',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('treats plain-group converted threads as their own scope', async () => {
    const h = await createHarness({
      chatMode: 'group',
      rawThreadIds: { om_plain_thread: 'omt_plain_thread' },
    });
    const threadWorkspace = join(h.tmp.root, 'thread-workspace');
    await mkdir(threadWorkspace, { recursive: true });
    h.workspaces.setCwd('oc_topic_chat:omt_plain_thread', await realpath(threadWorkspace));

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_plain_thread',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        content: '@Bridge 这里按话题隔离',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const run = h.agent.runOptions[0];
    expect(run?.cwd).toBe(await realpath(threadWorkspace));
    expect(run?.prompt).toContain('"threadId":"omt_plain_thread"');
    expect(run?.prompt).not.toContain('<quoted_messages>');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledTimes(1);
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_plain_thread',
      expect.objectContaining({ cardContentType: null }),
    );
    await waitFor(() => h.channel.streamCalls.length === 1);
    expect(h.channel.streamCalls[0]?.input).toHaveProperty('card');
    expect(h.channel.streamCalls[0]?.options).toEqual({
      replyTo: 'om_plain_thread',
      replyInThread: true,
    });
  });

  it('injects prior replies from another agent as shared topic context', async () => {
    const h = await createHarness();
    await h.topicContext.append('oc_topic_chat:omt_topic', {
      id: 'run_claude',
      role: 'assistant',
      speaker: 'lark-claudecode',
      agent: 'claude',
      text: 'Claude 已确认入口在 src/main.ts',
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_for_codex',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 继续检查',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<shared_topic_context>');
    expect(prompt).toContain('Claude 已确认入口在 src/main.ts');
    expect(prompt).toContain('lark-claudecode');
  });
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  topicContext: TopicContextStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const topicContext = new TopicContextStore(join(tmp.profile, 'topic-context'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
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
    topicContext,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  topicContext: TopicContextStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    topicContext: h.topicContext,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const rawThreadIds = options.rawThreadIds ?? {};
  const streamCalls: Array<{ input: unknown; options?: unknown }> = [];
  return {
    handlers,
    streamCalls,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input, options) {
      streamCalls.push({ input, options });
      if (isCardStreamInput(input)) {
        await input.card.producer({ update: async () => {} });
        return;
      }
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
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

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

interface CardStreamInput {
  card: {
    producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> | void;
  };
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

function isCardStreamInput(input: unknown): input is CardStreamInput {
  return Boolean(input && typeof input === 'object' && 'card' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
