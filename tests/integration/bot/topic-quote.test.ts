import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { fetchTopicContext } from '../../../src/bot/quote.js';
import { LUMOS_OWNER_OPEN_ID } from '../../../src/policy/lumos-owner.js';

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
    // The agent has to say something for a progress stream to exist at all —
    // see "does not open a progress stream when the agent produces no content".
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [
        { type: 'text', delta: '好的' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

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
      agentEvents: [
        { type: 'text', delta: '好的' },
        { type: 'done', terminationReason: 'normal' },
      ],
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

  it('recovers a missing threadId when a stale group-mode cache hides a converted topic', async () => {
    const h = await createHarness({
      chatMode: 'group',
      rawThreadIds: { om_converted_opener: 'omt_converted_opener' },
      agentEvents: [
        { type: 'text', delta: '好的' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_converted_opener',
        rootId: 'om_converted_opener',
        parentId: 'om_converted_opener',
        content: '@Bridge 这是转换后的新话题',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_converted_opener');
    expect(h.agent.runOptions[0]?.prompt).toContain('"threadId":"omt_converted_opener"');
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).toMatchObject({
      replyTo: 'om_converted_opener',
      replyInThread: true,
    });
  });

  it('fails closed when a topic-group event has no recoverable threadId', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      agentEvents: [
        { type: 'text', delta: '好的' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_thread',
        rootId: 'om_no_thread',
        parentId: 'om_no_thread',
        content: '@Bridge 无线程',
      }),
    );
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_no_thread');
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.sent).toContainEqual(expect.objectContaining({
      chatId: 'oc_topic_chat',
      options: { replyTo: 'om_no_thread', replyInThread: true },
    }));
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
    expect(h.agent.runOptions[0]?.sandbox).toBe('read-only');
    expect(h.agent.runOptions[0]?.permissionMode).toBe('plan');
    expect(prompt).toContain('<topic_context>');
    expect(prompt).toContain('the real upstream question');
    // The triggering message is in the thread list too — it must be excluded so
    // it isn't duplicated inside topic_context.
    const topicBlock = prompt.slice(prompt.indexOf('<topic_context>'), prompt.indexOf('</topic_context>'));
    expect(topicBlock).not.toContain('om_at_in_topic');
  });

  it('fetches only incremental topic context after an existing session cursor', async () => {
    // Topic history is now replayed from a lightweight cursor even when the
    // resumed session already exists. This keeps Codex (whose thread is stored
    // in SessionCatalog) and Claude on the same incremental path.
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
        {
          message_id: 'om_previous_trigger',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge 上一轮' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000001000',
          thread_id: 'omt_existing',
        },
        {
          message_id: 'om_incremental',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '上一轮之后的新消息' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000002000',
          thread_id: 'omt_existing',
        },
        {
          message_id: 'om_followup',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge 接着说' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000003000',
          thread_id: 'omt_existing',
        },
      ],
    });
    // Seed a session for the topic scope so it looks already-engaged.
    h.sessions.set('oc_topic_chat:omt_existing', 'sess_existing', await realpath(h.tmp.workspace));
    h.sessions.setTopicCursor('oc_topic_chat:omt_existing', {
      messageId: 'om_previous_trigger',
      createTime: 1760000001000,
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_followup',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_existing',
        content: '@Bridge 接着说',
        createTime: 1760000003000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalled();
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<topic_context>');
    const topicBlock = prompt.slice(prompt.indexOf('<topic_context>'), prompt.indexOf('</topic_context>'));
    expect(topicBlock).toContain('上一轮之后的新消息');
    expect(topicBlock).not.toContain('the real upstream question');
    expect(topicBlock).not.toContain('om_previous_trigger');
    expect(topicBlock).not.toContain('om_followup');
  });

  it('replays a message that was missing from an earlier eventually-consistent list page', async () => {
    // m1 was the previous cursor. The first read sees m3+m1 while m2 is still
    // absent from Feishu's index; after m3 advances the cursor, the overlap
    // read on m4 must still admit m2 when it appears later.
    const h = await createHarness({
      chatMode: 'topic',
      threadPages: [
        {
          items: [
            {
              message_id: 'om_m3',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: '@Bridge m3' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000003000',
            },
            {
              message_id: 'om_m1',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'm1' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000001000',
            },
          ],
        },
        {
          items: [
            {
              message_id: 'om_m4',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: '@Bridge m4' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000004000',
            },
            {
              message_id: 'om_m3',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: '@Bridge m3' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000003000',
            },
            {
              message_id: 'om_m2',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'm2 arrived late' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000002000',
            },
            {
              message_id: 'om_m1',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'm1' }) },
              sender: { id: 'ou_user', sender_type: 'user' },
              create_time: '1760000001000',
            },
          ],
        },
      ],
    });
    h.sessions.setTopicCursor('oc_topic_chat:omt_eventual', {
      messageId: 'om_m1',
      createTime: 1760000001000,
      recentMessageIds: ['om_m1'],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_m3',
        rootId: 'om_m1',
        parentId: 'om_m1',
        threadId: 'omt_eventual',
        content: '@Bridge m3',
        createTime: 1760000003000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.sessions.getTopicCursor('oc_topic_chat:omt_eventual')?.messageId === 'om_m3');

    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_eventual')).toEqual(
      expect.objectContaining({
        messageId: 'om_m3',
        recentMessageIds: expect.arrayContaining(['om_m1', 'om_m3']),
      }),
    );

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_m4',
        rootId: 'om_m1',
        parentId: 'om_m1',
        threadId: 'omt_eventual',
        content: '@Bridge m4',
        createTime: 1760000004000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    const prompt = h.agent.runOptions[1]?.prompt ?? '';
    expect(prompt).toContain('m2 arrived late');
    expect(prompt).not.toContain('\n m1\n');
  });

  it('paginates the full topic before taking the latest 40 messages', async () => {
    const makeItem = (index: number): Record<string, unknown> => ({
      message_id: `om_long_${index}`,
      msg_type: 'text',
      body: { content: JSON.stringify({ text: `long topic ${index}` }) },
      sender: { id: 'ou_user', sender_type: 'user' },
      create_time: String(1760000000000 + index * 1000),
      thread_id: 'omt_long',
    });
    const firstPage = Array.from({ length: 30 }, (_, index) => makeItem(49 - index));
    const secondPage = Array.from({ length: 20 }, (_, index) => makeItem(19 - index));
    const h = await createHarness({
      chatMode: 'topic',
      threadPages: [
        { items: firstPage, hasMore: true, pageToken: 'page-2' },
        { items: secondPage, hasMore: false },
      ],
    });

    const context = await fetchTopicContext(h.channel as unknown as LarkChannel, 'omt_long', {
      maxMessages: 40,
    });

    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(2);
    expect(context).toHaveLength(40);
    expect(context[0]?.messageId).toBe('om_long_10');
    expect(context.at(-1)?.messageId).toBe('om_long_49');
  });

  it('does not replay pre-cursor history from the bounded overlap on a long topic', async () => {
    const makeItem = (index: number): Record<string, unknown> => ({
      message_id: `om_window_${index}`,
      msg_type: 'text',
      body: { content: JSON.stringify({ text: `window topic ${index}` }) },
      sender: { id: 'ou_user', sender_type: 'user' },
      create_time: String(1760000100000 + index * 1000),
      thread_id: 'omt_long_incremental',
    });
    const firstPage = Array.from({ length: 50 }, (_, offset) => makeItem(100 - offset));
    const secondPage = Array.from({ length: 50 }, (_, offset) => makeItem(50 - offset));
    const nextFirstPage = Array.from({ length: 50 }, (_, offset) => makeItem(101 - offset));
    const nextSecondPage = Array.from({ length: 50 }, (_, offset) => makeItem(51 - offset));
    const h = await createHarness({
      chatMode: 'topic',
      threadPages: [
        { items: firstPage, hasMore: true, pageToken: 'first-page-2' },
        { items: secondPage, hasMore: false },
        { items: nextFirstPage, hasMore: true, pageToken: 'next-page-2' },
        { items: nextSecondPage, hasMore: false },
      ],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_window_100',
        rootId: 'om_window_100',
        parentId: 'om_window_100',
        threadId: 'omt_long_incremental',
        content: '@Bridge first long turn',
        createTime: 1760000200000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(
      () => h.sessions.getTopicCursor('oc_topic_chat:omt_long_incremental')?.messageId === 'om_window_100',
    );

    const cursor = h.sessions.getTopicCursor('oc_topic_chat:omt_long_incremental');
    expect(cursor?.recentMessageIds).toHaveLength(100);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_window_101',
        rootId: 'om_window_100',
        parentId: 'om_window_100',
        threadId: 'omt_long_incremental',
        content: '@Bridge second long turn',
        createTime: 1760000201000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    const prompt = h.agent.runOptions[1]?.prompt ?? '';
    expect(prompt).not.toContain('window topic 50');
    expect(prompt).not.toContain('window topic 2');
    expect(prompt).not.toContain('<topic_context>');
  });

  it('excludes the triggering batch, explicit quotes, deleted messages, and bot replies', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_after_cursor',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'include me' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000002000',
        },
        {
          message_id: 'om_explicit_quote',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'quoted separately' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000003000',
        },
        {
          message_id: 'om_deleted',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'do not include' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000004000',
          deleted: true,
        },
        {
          message_id: 'om_bot_reply',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'bot answer' }) },
          sender: { id: 'ou_bot', sender_type: 'app' },
          create_time: '1760000005000',
        },
        {
          message_id: 'om_trigger',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge trigger' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000006000',
        },
      ],
    });

    const context = await fetchTopicContext(h.channel as unknown as LarkChannel, 'omt_topic', {
      maxMessages: 40,
      after: { messageId: 'om_previous', createTime: 1760000001000 },
      before: { messageId: 'om_trigger', createTime: 1760000006000 },
      excludeIds: new Set(['om_explicit_quote', 'om_trigger']),
      botOpenId: 'ou_bot',
    });

    expect(context.map((item) => item.messageId)).toEqual(['om_after_cursor']);
  });

  it('keeps same-millisecond rows when a deleted boundary id falls back to timestamps', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_same_time',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'same millisecond context' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000020000',
        },
        {
          message_id: 'om_older',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'older context' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000019000',
        },
      ],
    });

    const context = await fetchTopicContext(h.channel as unknown as LarkChannel, 'omt_same_time', {
      maxMessages: 40,
      after: { messageId: 'om_deleted_cursor', createTime: 1760000020000 },
      before: { messageId: 'om_deleted_trigger', createTime: 1760000030000 },
    });

    expect(context.map((item) => item.messageId)).toEqual(['om_same_time']);
  });

  it('stops topic pagination at the page budget and marks the cursor read incomplete', async () => {
    const pages = Array.from({ length: 11 }, (_, index) => ({
      items: [{
        message_id: `om_page_${index}`,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: `page ${index}` }) },
        sender: { id: 'ou_user', sender_type: 'user' },
        create_time: String(1760000100000 - index),
      }],
      hasMore: true,
      pageToken: `page-${index + 1}`,
    }));
    const h = await createHarness({ chatMode: 'topic', threadPages: pages });
    const status = { complete: true };

    await fetchTopicContext(h.channel as unknown as LarkChannel, 'omt_budget', {
      maxMessages: 40,
      after: { messageId: 'om_missing_cursor', createTime: 1760000000000 },
      before: { messageId: 'om_missing_trigger', createTime: 1760000200000 },
      status,
    });

    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(10);
    expect(status.complete).toBe(false);
  });

  it('does not advance the cursor when run startup is rejected', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    h.profileConfig.workspaces.default = '/definitely/missing-workspace';

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_rejected',
        rootId: 'om_rejected',
        parentId: 'om_rejected',
        threadId: 'omt_rejected',
        content: '@Bridge start',
        createTime: 1760000007000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_rejected')).toBeUndefined();
  });

  it('does not advance the cursor when an accepted run immediately emits an error', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      agentEvents: [{ type: 'error', message: 'startup failed', terminationReason: 'failed' }],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_stream_error',
        rootId: 'om_stream_error',
        parentId: 'om_stream_error',
        threadId: 'omt_stream_error',
        content: '@Bridge start',
        createTime: 1760000008000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_stream_error')).toBeUndefined();
  });

  it('does not treat a Codex thread-id-only system event as cursor startup evidence', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      chatMode: 'topic',
      agentEvents: [
        { type: 'system', threadId: 'codex-thread-before-turn' },
        { type: 'error', message: 'turn/start failed', terminationReason: 'failed' },
      ],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_codex_thread_only',
        rootId: 'om_codex_thread_only',
        parentId: 'om_codex_thread_only',
        threadId: 'omt_codex_thread_only',
        content: '@Bridge start',
        createTime: 1760000011000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_codex_thread_only')).toBeUndefined();
  });

  it('does not advance the cursor when topic history cannot be fetched', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadListError: new Error('history unavailable'),
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_history_error',
        rootId: 'om_history_error',
        parentId: 'om_history_error',
        threadId: 'omt_history_error',
        content: '@Bridge start',
        createTime: 1760000009000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_history_error')).toBeUndefined();
  });

  it('keeps an explicit quote in topic context when its direct fetch fails', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      quotedMessageErrors: new Set(['om_quote_unavailable']),
      threadMessages: [
        {
          message_id: 'om_quote_unavailable',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'quote still visible upstream' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000009500',
          thread_id: 'omt_quote_unavailable',
        },
        {
          message_id: 'om_quote_trigger',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge look' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000010000',
          thread_id: 'omt_quote_unavailable',
        },
      ],
    });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_quote_trigger',
        rootId: 'om_quote_root',
        parentId: 'om_quote_unavailable',
        threadId: 'omt_quote_unavailable',
        content: '@Bridge look',
        createTime: 1760000010000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('quote still visible upstream');
    expect(h.sessions.getTopicCursor('oc_topic_chat:omt_quote_unavailable')).toEqual(
      expect.objectContaining({
        messageId: 'om_quote_trigger',
        createTime: 1760000010000,
        recentMessageIds: expect.arrayContaining([
          'om_quote_trigger',
          'om_quote_unavailable',
        ]),
      }),
    );
  });

  it('uses the same incremental cursor when Codex persists its thread in SessionCatalog', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      chatMode: 'topic',
      agentEvents: [
        { type: 'system', threadId: 'codex-thread' },
        { type: 'done', terminationReason: 'normal' },
      ],
      threadMessages: [
        {
          message_id: 'om_codex_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'Codex root' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000000000',
        },
        {
          message_id: 'om_codex_first',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge first' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000001000',
        },
        {
          message_id: 'om_codex_incremental',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'Codex incremental' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000002000',
        },
        {
          message_id: 'om_codex_second',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge second' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000003000',
        },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_codex_first',
        rootId: 'om_codex_root',
        parentId: 'om_codex_root',
        threadId: 'omt_codex',
        content: '@Bridge first',
        createTime: 1760000001000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.sessions.getTopicCursor('oc_topic_chat:omt_codex') !== undefined);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_codex_second',
        rootId: 'om_codex_root',
        parentId: 'om_codex_root',
        threadId: 'omt_codex',
        content: '@Bridge second',
        createTime: 1760000003000,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    const prompt = h.agent.runOptions[1]?.prompt ?? '';
    const topicBlock = prompt.slice(prompt.indexOf('<topic_context>'), prompt.indexOf('</topic_context>'));
    expect(topicBlock).toContain('Codex incremental');
    expect(topicBlock).not.toContain('Codex root');
    expect(h.sessionCatalog?.entries()).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'codex', threadId: 'codex-thread' })]),
    );
  });

  it('does not open a progress stream when the agent produces no content', async () => {
    // The SDK starts a stream eagerly and finishes an empty one with its
    // "(no content)" placeholder, so a content-less run used to post a card and
    // recall it seconds later. Nothing durable to show → no message at all.
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [{ type: 'done', terminationReason: 'normal' }],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_empty', rootId: 'om_empty', parentId: 'om_empty', content: '@Bridge ping' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    // give the (absent) stream and its recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.recallMessage).not.toHaveBeenCalled();
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

  it('requires a structured bot mention for Lumos even when legacy config disables it', async () => {
    const h = await createHarness({ chatMode: 'group' });
    h.controls.profile = 'lumos';
    h.profileConfig.access.requireMentionInGroup = false;

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_at',
        rootId: 'om_no_at',
        parentId: 'om_no_at',
        content: '@同事 这里的帖子哪些是我们做的',
        mentionedBot: false,
        senderId: LUMOS_OWNER_OPEN_ID,
      }),
    );
    // no run should start; give the pipeline a moment to (not) act
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.recallMessage).not.toHaveBeenCalled();
    expect(h.channel.getChatMode).not.toHaveBeenCalled();
    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('keeps no-mention group intake enabled for non-Lumos profiles configured false', async () => {
    const h = await createHarness({ chatMode: 'group' });
    h.profileConfig.access.requireMentionInGroup = false;

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_legacy_no_at',
        rootId: 'om_legacy_no_at',
        parentId: 'om_legacy_no_at',
        content: '这条旧配置允许不 @ 机器人也处理',
        mentionedBot: false,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.channel.getChatMode).toHaveBeenCalledTimes(1);
  });

  it('never lets a non-owner trigger the Lumos profile even when generic access allows them', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    h.controls.profile = 'lumos';

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_non_owner',
        rootId: 'om_non_owner',
        parentId: 'om_non_owner',
        threadId: 'omt_non_owner',
        content: '@Bridge 执行任务',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.getChatMode).not.toHaveBeenCalled();
    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
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
});

describe('merge_forward fetch failure', () => {
  it('skips the run and hints the user when the SDK could not fetch a merge_forward', async () => {
    // @larksuite/channel >= 0.4.1 normalizes an un-fetchable merge_forward to
    // the fetch_failed sentinel. Feeding it to the agent would look like an
    // empty forward, so intake must reply a recoverable hint and start no run.
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_forward_failed',
        rootId: 'om_forward_failed',
        parentId: 'om_forward_failed',
        content: '<forwarded_messages status="fetch_failed"/>',
        rawContentType: 'merge_forward',
      }),
    );
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);
    const hint = h.channel.sent.at(-1);
    expect(hint?.options).toMatchObject({ replyTo: 'om_forward_failed' });
    expect((hint?.content as { text?: string }).text).toContain('重新转发');
  });

  it('still runs when a merge_forward was genuinely empty (not a fetch failure)', async () => {
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_forward_empty',
        rootId: 'om_forward_empty',
        parentId: 'om_forward_empty',
        content: '<forwarded_messages/>',
        rawContentType: 'merge_forward',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });
});

async function createHarness(options: {
  agentKind?: 'claude' | 'codex';
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  quotedMessageErrors?: Set<string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  threadListError?: Error;
  threadPages?: Array<{
    items: Array<Record<string, unknown>>;
    hasMore?: boolean;
    pageToken?: string;
  }>;
  agentEvents?: AgentEvent[];
} = {}):Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'claude',
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
    ...(options.agentKind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex' } }
      : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog =
    options.agentKind === 'codex'
      ? new SessionCatalog(join(tmp.profile, 'session-catalog.json'))
      : undefined;
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: options.agentEvents ?? [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), sessionCatalog?.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    ...(h.sessionCatalog ? { sessionCatalog: h.sessionCatalog } : {}),
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  quotedMessageErrors?: Set<string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  threadListError?: Error;
  threadPages?: Array<{
    items: Array<Record<string, unknown>>;
    hasMore?: boolean;
    pageToken?: string;
  }>;
} = {}):FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const quotedMessageErrors = options.quotedMessageErrors ?? new Set<string>();
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  const threadListError = options.threadListError;
  const threadPages = options.threadPages ?? [];
  let threadPageIndex = 0;
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
            list: vi.fn(async () => {
              if (threadListError) throw threadListError;
              const page = threadPages[threadPageIndex++];
              if (!page) return { data: { items: threadMessages, has_more: false } };
              return {
                data: {
                  items: page.items,
                  has_more: page.hasMore ?? Boolean(page.pageToken),
                  ...(page.pageToken ? { page_token: page.pageToken } : {}),
                },
              };
            }),
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
    fetchRawMessage: vi.fn(async (messageId: string) => {
      if (quotedMessageErrors.has(messageId)) {
        throw new Error(`quote unavailable: ${messageId}`);
      }
      return [
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
      ];
    }),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    getChatMode: vi.fn(async () => {
      return chatMode;
    }),
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
  senderId?: string;
  rawContentType?: string;
  mentionedBot?: boolean;
  mentions?: Array<{ key: string; openId: string; name: string; isBot: boolean }>;
  createTime?: number;
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: input.rawContentType ?? 'text',
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
    createTime: input.createTime ?? 1760000001000,
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
