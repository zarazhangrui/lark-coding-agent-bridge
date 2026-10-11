import { describe, expect, it } from 'vitest';
import { LarkProactiveHistorySource } from '../../../src/proactive/history';

describe('proactive history recovery', () => {
  it('normalizes user text while excluding app, malformed, and bot-mentioned messages', async () => {
    const calls: unknown[] = [];
    const source = new LarkProactiveHistorySource(
      {
        im: {
          v1: {
            message: {
              async list(input: unknown) {
                calls.push(input);
                return {
                  code: 0,
                  data: {
                    items: [
                      {
                        message_id: 'm_ok',
                        thread_id: 'omt_1',
                        chat_id: 'oc_intern',
                        msg_type: 'text',
                        create_time: '1234',
                        sender: { id: 'ou_user', sender_type: 'user', sender_name: '测试用户' },
                        body: { content: JSON.stringify({ text: ' 已完成 ' }) },
                      },
                      {
                        message_id: 'm_bot_mentioned',
                        msg_type: 'text',
                        create_time: '1235',
                        sender: { id: 'ou_user', sender_type: 'user' },
                        mentions: [{ id: 'ou_bot' }],
                        body: { content: JSON.stringify({ text: '@机器人 执行' }) },
                      },
                      {
                        message_id: 'm_post',
                        thread_id: 'omt_1',
                        chat_id: 'oc_intern',
                        msg_type: 'post',
                        create_time: '1236',
                        sender: { id: 'ou_user', sender_type: 'user', sender_name: '测试用户' },
                        body: {
                          content: JSON.stringify({
                            zh_cn: {
                              title: '',
                              content: [[{ tag: 'text', text: '我需要在 3 分钟后完成验收' }]],
                            },
                          }),
                        },
                      },
                      {
                        message_id: 'm_app',
                        msg_type: 'text',
                        create_time: '1237',
                        sender: { id: 'cli_app', sender_type: 'app' },
                        body: { content: JSON.stringify({ text: '机器人消息' }) },
                      },
                    ],
                  },
                };
              },
            },
          },
        },
      },
      () => 'ou_bot',
    );

    await expect(source.listThread('oc_intern', 'omt_1', 1_000)).resolves.toEqual([
      {
        messageId: 'm_ok',
        chatId: 'oc_intern',
        threadId: 'omt_1',
        senderId: 'ou_user',
        senderName: '测试用户',
        text: '已完成',
        createTime: 1234,
      },
      {
        messageId: 'm_post',
        chatId: 'oc_intern',
        threadId: 'omt_1',
        senderId: 'ou_user',
        senderName: '测试用户',
        text: '我需要在 3 分钟后完成验收',
        createTime: 1236,
      },
    ]);
    expect(calls[0]).toMatchObject({
      params: {
        container_id_type: 'thread',
        container_id: 'omt_1',
        start_time: '1',
        sort_type: 'ByCreateTimeAsc',
      },
    });
  });

  it('requests only topic roots when reconciling an allowlisted chat', async () => {
    const calls: Array<{ params?: Record<string, unknown> }> = [];
    const source = new LarkProactiveHistorySource(
      {
        im: {
          v1: {
            message: {
              async list(input: { params?: Record<string, unknown> }) {
                calls.push(input);
                return { code: 0, data: { items: [] } };
              },
            },
          },
        },
      },
      () => undefined,
    );

    await source.listChatRoots('oc_intern', 2_000);
    expect(calls[0]?.params).toMatchObject({
      container_id_type: 'chat',
      container_id: 'oc_intern',
      only_thread_root_messages: true,
      start_time: '2',
    });
  });
});
