import { describe, expect, it } from 'vitest';
import { JevDecisionProvider } from '../../../src/proactive/decision';

describe('Jev decision provider', () => {
  it('sends a fixed structured question and maps the choice response', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const provider = new JevDecisionProvider('test-key', async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            action: {
              type: 'choice',
              choice: 'create',
              confidence: 0.91,
              probabilities: {
                ignore: 0.01,
                create: 0.91,
                complete: 0.02,
                cancel: 0.01,
                postpone: 0.02,
                clarify: 0.03,
                'possible-complex-task': 0,
              },
            },
          },
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const decision = await provider.decide({
      message: {
        messageId: 'm_latest',
        chatId: 'oc_intern',
        senderId: 'ou_user',
        text: '明天交报告',
        createTime: 2,
      },
      recentMessages: [
        {
          messageId: 'm_previous',
          chatId: 'oc_intern',
          senderId: 'ou_other',
          text: '收到',
          createTime: 1,
        },
      ],
      pendingFollowUps: [],
      now: 3,
    });

    expect(decision).toEqual({ action: 'create', confidence: 0.91, model: 'jev-test' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(requests[0]?.body).toMatchObject({
      model: 'jev-latest',
      state: {
        latest_message: { messageId: 'm_latest' },
        recent_messages: [{ messageId: 'm_previous' }],
      },
      questions: {
        action: { type: 'choice' },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).toContain('不可信数据');
    expect(JSON.stringify(requests[0]?.body)).toContain('possible-complex-task');
    expect(JSON.stringify(requests[0]?.body)).toContain('标记完成');
  });
});

