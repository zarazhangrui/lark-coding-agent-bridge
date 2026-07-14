import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { AgentEvent } from '../../../src/agent/types.js';
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

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options: unknown }>;
  streams: Array<{ chatId: string; options: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: {
          list: ReturnType<typeof vi.fn>;
        };
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
  recallMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
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

  it('treats messages with threadId as topic messages even when chat mode cache says group', async () => {
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_converted_topic',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_converted_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_converted_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).toMatchObject({
      replyTo: 'om_converted_topic',
      replyInThread: true,
    });
  });

  it('backfills a missing threadId in topic groups so the reply threads into the topic', async () => {
    // Feishu drops thread_id on a chunk of topic-group events (notably the
    // message that opens a topic). getChatMode still reports 'topic', so we
    // recover the thread_id from the raw message instead of letting the reply
    // escape into a brand-new topic.
    const h = await createHarness({
      chatMode: 'topic',
      rawThreadIds: { om_topic_start: 'omt_backfilled' },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_start',
        rootId: 'om_topic_start',
        parentId: 'om_topic_start',
        // no threadId on the event
        content: '@Bridge 开个新话题',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_topic_start');
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_backfilled"');

    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).toMatchObject({
      replyTo: 'om_topic_start',
      replyInThread: true,
    });
  });

  it('does not thread the reply when a topic-group event has no recoverable threadId', async () => {
    // Backfill lookup returns nothing → degrade gracefully to chat-level
    // routing rather than crashing or blocking the run.
    const h = await createHarness({ chatMode: 'topic' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_thread',
        rootId: 'om_no_thread',
        parentId: 'om_no_thread',
        content: '@Bridge 无线程',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_no_thread');
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).not.toMatchObject({ replyInThread: true });
  });

  it('pulls in the topic upstream messages when first engaged in a topic', async () => {
    // The topic root holds the real question and never @-mentioned the bot; the
    // bot only gets pulled in by a later "@Bridge 看下这个" reply. On a fresh
    // topic session we fetch the thread so the agent isn't blind to the root.
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'the real upstream question' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_topic',
        },
        {
          // the triggering message itself — must be excluded, not echoed back
          message_id: 'om_at_in_topic',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge 看下这个' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000001000',
          thread_id: 'omt_topic',
        },
      ],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_at_in_topic',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 看下这个',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          container_id_type: 'thread',
          container_id: 'omt_topic',
        }),
      }),
    );
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<topic_context>');
    expect(prompt).toContain('the real upstream question');
    // The triggering message is in the thread list too — it must be excluded so
    // it isn't duplicated inside topic_context.
    const topicBlock = prompt.slice(prompt.indexOf('<topic_context>'), prompt.indexOf('</topic_context>'));
    expect(topicBlock).not.toContain('om_at_in_topic');
  });

  it('does not fetch topic context when the topic session already exists', async () => {
    // A prior session for this topic scope means the history is already in the
    // resumed conversation — no need to re-fetch and re-inject it every turn.
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'the real upstream question' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_existing',
        },
      ],
    });
    // Seed a session for the topic scope so it looks already-engaged.
    h.sessions.set('oc_topic_chat:omt_existing', 'sess_existing', await realpath(h.tmp.workspace));

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_followup',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_existing',
        content: '@Bridge 接着说',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).not.toContain('<topic_context>');
  });

  it('recalls the streamed message when the agent produces no content', async () => {
    // Empty agent output must not leave an "(no content)" card behind — the SDK
    // creates the streaming card eagerly, so we recall it when nothing renders.
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [{ type: 'done', terminationReason: 'normal' }],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_empty', rootId: 'om_empty', parentId: 'om_empty', content: '@Bridge ping' }),
    );
    await waitFor(() => h.channel.streams.length === 1);
    await waitFor(() => h.channel.recallMessage.mock.calls.length === 1);

    expect(h.channel.recallMessage).toHaveBeenCalledWith('om_stream_1');
  });

  it('does not recall when the agent produced real content', async () => {
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [
        { type: 'text', delta: '这是真正的回答' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_real', rootId: 'om_real', parentId: 'om_real', content: '@Bridge 问题' }),
    );
    await waitFor(() => h.channel.streams.length === 1);
    // give any (erroneous) recall a chance to fire before asserting it didn't
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.channel.recallMessage).not.toHaveBeenCalled();
  });

  it('skips a group message that does not mention the bot (requireMention default)', async () => {
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_at',
        rootId: 'om_no_at',
        parentId: 'om_no_at',
        content: '@同事 这里的帖子哪些是我们做的',
        mentionedBot: false,
      }),
    );
    // no run should start; give the pipeline a moment to (not) act
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.recallMessage).not.toHaveBeenCalled();
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
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  agentEvents?: AgentEvent[];
} = {}):Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
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
  const agent = new FakeAgentAdapter({
    events: options.agentEvents ?? [{ type: 'done', terminationReason: 'normal' }],
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
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
} = {}):FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  return {
    handlers,
    sent,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            list: vi.fn(async () => ({ data: { items: threadMessages, has_more: false } })),
          },
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
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
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
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
      return { messageId: `om_stream_${streams.length}` };
    },
    recallMessage: vi.fn(async () => {}),
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
  mentionedBot?: boolean;
  mentions?: Array<{ key: string; openId: string; name: string; isBot: boolean }>;
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions:
      input.mentions ??
      (mentionedBot
        ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
        : [{ key: '@_user_1', openId: 'ou_human', name: '同事', isBot: false }]),
    mentionAll: false,
    mentionedBot,
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

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
