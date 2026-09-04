import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type {
  FakeAgentEvents,
  FakeWaitForExitResult,
} from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
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

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  /** Every send invocation, including rejected and receipt-less attempts. */
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  /** Only sends that resolved with a non-empty message receipt. */
  delivered: Array<{ chatId: string; content: unknown; options?: unknown }>;
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
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('configures a loss-tolerant SDK ping watchdog', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    expect(sdkMock.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        wsConfig: { pingTimeout: 20 },
      }),
    );
  });

  it('wires the configured post-terminal exit grace into channel runs', async () => {
    const h = await createHarness({ postDoneExitGraceMs: 120_000 });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cleanup_grace', 'run'));
    await waitFor(() => h.agent.runs[0]?.waitForExitCalls === 1);

    expect(h.agent.runs[0]?.waitForExitTimeouts).toEqual([120_000]);
  });

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

  it('keeps a queued same-scope turn blocked until post-terminal cleanup settles', async () => {
    const firstExit = deferred<boolean>();
    const h = await createHarness({
      events: [
        [
          { type: 'final_text', content: 'FIRST_FINAL_BEFORE_CLEANUP' },
          { type: 'done', terminationReason: 'normal' },
        ],
        [
          { type: 'final_text', content: 'SECOND_FINAL_AFTER_CLEANUP' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      waitForExit: [firstExit.promise, true],
    });
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.(message('om_cleanup_first', 'first'));
      await waitFor(() =>
        h.channel.sent.some((sent) =>
          JSON.stringify(sent.content).includes('FIRST_FINAL_BEFORE_CLEANUP'),
        ),
      );
      await waitFor(() => h.agent.runs[0]?.waitForExitCalls === 1);

      await h.channel.handlers.message?.(message('om_cleanup_second', 'second'));
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(h.agent.runs).toHaveLength(1);
    } finally {
      firstExit.resolve(true);
    }

    await waitFor(() => h.agent.runs.length === 2);
    await waitFor(() =>
      h.channel.sent.some((sent) =>
        JSON.stringify(sent.content).includes('SECOND_FINAL_AFTER_CLEANUP'),
      ),
    );
    expect(h.agent.runOptions).toHaveLength(2);
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

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
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
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });
  });

  it('opens no progress stream for a final-only round', async () => {
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('does not repeat streamed text as the final reply when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // give a (duplicate) final reply a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it.each([
    {
      name: 'failure',
      event: {
        type: 'error',
        message: 'codex stream ended before a terminal event',
        terminationReason: 'failed',
      } satisfies AgentEvent,
      notice: 'agent 失败',
    },
    {
      name: 'interruption',
      event: { type: 'done', terminationReason: 'interrupted' } satisfies AgentEvent,
      notice: '已被中断',
    },
    {
      name: 'timeout',
      event: { type: 'done', terminationReason: 'timeout' } satisfies AgentEvent,
      notice: '已自动终止',
    },
  ])('sends one dedicated terminal fallback after a streamed $name', async ({ event, notice }) => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [{ type: 'text', delta: 'progress update' }, event],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message(`om_${event.terminationReason}`, 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain(notice);
    expect(visibleProgress.some((markdown) => markdown.includes(notice))).toBe(false);
    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
  });

  it.each([
    {
      name: 'failure',
      event: {
        type: 'error',
        message: 'claude stream ended before a terminal event',
        terminationReason: 'failed',
      } satisfies AgentEvent,
      notice: 'agent 失败',
    },
    {
      name: 'interruption',
      event: { type: 'done', terminationReason: 'interrupted' } satisfies AgentEvent,
      notice: '已被中断',
    },
    {
      name: 'timeout',
      event: { type: 'done', terminationReason: 'timeout' } satisfies AgentEvent,
      notice: '已自动终止',
    },
  ])(
    'sends one durable Claude terminal fallback without repeating progress after a streamed $name',
    async ({ event, notice }) => {
      const visibleProgress: string[] = [];
      const h = await createHarness({
        agentKind: 'claude',
        events: [{ type: 'text', delta: 'CLAUDE_PROGRESS' }, event],
        stream: async (_chatId, input) => {
          const producer = (input as {
            markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
          }).markdown;
          await producer?.({
            setContent: vi.fn(async (markdown: string) => {
              visibleProgress.push(markdown);
            }),
          });
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_claude_${event.terminationReason}`, 'run'));
      await waitFor(() => h.channel.delivered.length === 1);

      expect(h.channel.delivered).toHaveLength(1);
      expect(lastDeliveredMarkdown(h.channel)).toContain(notice);
      expect(lastDeliveredMarkdown(h.channel)).not.toContain('CLAUDE_PROGRESS');
      expect(visibleProgress.some((markdown) => markdown.includes(notice))).toBe(false);
      expect(visibleProgress.some((markdown) => markdown.includes('CLAUDE_PROGRESS'))).toBe(true);
    },
  );

  it.each(['codex', 'claude'] as const)(
    'reserves a streamed %s card failure for one dedicated terminal card',
    async (agentKind) => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      agentKind,
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        {
          type: 'error',
          message: 'CARD_TERMINAL_FAILURE',
          terminationReason: 'failed',
        },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_failure', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('CARD_TERMINAL_FAILURE');
    expect(JSON.stringify(progressCards)).not.toContain('CARD_TERMINAL_FAILURE');
    expect(JSON.stringify(progressCards)).toContain('progress update');
    },
  );

  it('delivers a Claude abnormal terminal after stream completion rejects', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'CLAUDE_PROGRESS' },
        {
          type: 'error',
          message: 'CLAUDE_TERMINAL_FAILURE',
          terminationReason: 'failed',
        },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
        throw new Error('stream completion failed');
      },
    });
    vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_stream_completion_failure', 'run'));
    await waitFor(() => h.channel.delivered.length === 1);

    expect(h.channel.delivered).toHaveLength(1);
    expect(lastDeliveredMarkdown(h.channel)).toContain('CLAUDE_TERMINAL_FAILURE');
    expect(lastDeliveredMarkdown(h.channel)).not.toContain('CLAUDE_PROGRESS');
    expect(visibleProgress.some((markdown) => markdown.includes('CLAUDE_PROGRESS'))).toBe(true);
  });

  it('falls back once when the active /stop command acknowledgement rejects', async () => {
    const progressWriteStarted = deferred<void>();
    const releaseProgressWrite = deferred<void>();
    const visibleProgress: string[] = [];
    let sendAttempt = 0;
    const h = await createHarness({
      agentKind: 'claude',
      events: [{ type: 'text', delta: 'progress update' }],
      holdOpen: true,
      send: async () => {
        sendAttempt++;
        if (sendAttempt === 1) throw new Error('command acknowledgement rejected');
        return { messageId: `delivered_${sendAttempt}` };
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
            if (markdown.includes('progress update')) {
              progressWriteStarted.resolve();
              await releaseProgressWrite.promise;
            }
          }),
        });
      },
    });
    vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stop_reject_claude', 'run'));
    await progressWriteStarted.promise;
    await h.channel.handlers.message?.(message('om_stop_reject_cmd_claude', '/stop'));
    expect(h.agent.runs[0]?.stopped).toBe(true);

    releaseProgressWrite.resolve();
    await waitFor(() => h.channel.delivered.length === 1);

    expect(h.channel.sent).toHaveLength(2);
    expect(h.channel.delivered).toHaveLength(1);
    expect(lastDeliveredMarkdown(h.channel)).toContain('已被中断');
    expect(deliveredAcknowledgements(h.channel)).toHaveLength(1);
    expect(visibleProgress.some((markdown) => markdown.includes('已被中断'))).toBe(false);
  });

  it('counts a delivered audit-safe /stop fallback as the sole acknowledgement', async () => {
    const progressWriteStarted = deferred<void>();
    const releaseProgressWrite = deferred<void>();
    const visibleProgress: string[] = [];
    let sendAttempt = 0;
    const h = await createHarness({
      agentKind: 'claude',
      events: [{ type: 'text', delta: 'progress update' }],
      holdOpen: true,
      send: async () => {
        sendAttempt++;
        if (sendAttempt === 1) {
          throw Object.assign(new Error('message does not pass the audit'), { code: 230028 });
        }
        return { messageId: 'audit_safe_ack' };
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
            if (markdown.includes('progress update')) {
              progressWriteStarted.resolve();
              await releaseProgressWrite.promise;
            }
          }),
        });
      },
    });
    vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stop_audit_claude', 'run'));
    await progressWriteStarted.promise;
    await h.channel.handlers.message?.(message('om_stop_audit_cmd_claude', '/stop'));
    releaseProgressWrite.resolve();
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runs[0]?.stopped).toBe(true);
    expect(h.channel.sent).toHaveLength(2);
    expect(h.channel.delivered).toHaveLength(1);
    expect(lastDeliveredMarkdown(h.channel)).toBe('命令已处理。');
    expect(deliveredAcknowledgements(h.channel)).toHaveLength(1);
    expect(visibleProgress.some((markdown) => markdown.includes('已被中断'))).toBe(false);
  });

  it.each(['codex', 'claude'] as const)(
    'acknowledges an in-flight %s /stop exactly once',
    async (agentKind) => {
      const progressWriteStarted = deferred<void>();
      const releaseProgressWrite = deferred<void>();
      const commandSendStarted = deferred<void>();
      const resolveCommandSend = deferred<{ messageId: string }>();
      const visibleProgress: string[] = [];
      const h = await createHarness({
        agentKind,
        events: [{ type: 'text', delta: 'progress update' }],
        holdOpen: true,
        send: async (_chatId, content) => {
          const markdown = (content as { markdown?: string }).markdown;
          if (markdown === '⏹ 已请求停止当前任务。') {
            commandSendStarted.resolve();
            return resolveCommandSend.promise;
          }
          return { messageId: 'unexpected_fallback' };
        },
        stream: async (_chatId, input) => {
          const producer = (input as {
            markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
          }).markdown;
          await producer?.({
            setContent: vi.fn(async (markdown: string) => {
              visibleProgress.push(markdown);
              if (markdown.includes('progress update')) {
                progressWriteStarted.resolve();
                await releaseProgressWrite.promise;
              }
            }),
          });
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_stop_${agentKind}`, 'run'));
      await progressWriteStarted.promise;
      const stopHandling = h.channel.handlers.message?.(
        message(`om_stop_cmd_${agentKind}`, '/stop'),
      );
      await commandSendStarted.promise;
      expect(h.agent.runs[0]?.stopped).toBe(true);

      releaseProgressWrite.resolve();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(h.channel.sent).toHaveLength(1);
      expect(h.channel.delivered).toHaveLength(0);

      resolveCommandSend.resolve({ messageId: `stop_ack_${agentKind}` });
      await stopHandling;
      await waitFor(
        () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(h.channel.sent).toHaveLength(1);
      expect(h.channel.delivered).toHaveLength(1);
      expect(lastDeliveredMarkdown(h.channel)).toBe('⏹ 已请求停止当前任务。');
      expect(deliveredAcknowledgements(h.channel)).toHaveLength(1);
      expect(visibleProgress.some((markdown) => markdown.includes('已被中断'))).toBe(false);
    },
  );

  it('keeps the first overlapping /stop acknowledgement as the sole terminal owner', async () => {
    const stopCompletion = deferred<void>();
    const firstAcknowledgement = deferred<{ messageId: string }>();
    const firstAcknowledgementStarted = deferred<void>();
    const visibleProgress: string[] = [];
    let stopAcknowledgementAttempts = 0;
    const h = await createHarness({
      agentKind: 'claude',
      events: [{ type: 'text', delta: 'progress before overlapping stops' }],
      holdOpen: true,
      stopEvent: { type: 'done', terminationReason: 'interrupted' },
      stopCompletion: stopCompletion.promise,
      send: async (_chatId, content) => {
        const markdown = (content as { markdown?: string }).markdown ?? '';
        if (markdown === '⏹ 已请求停止当前任务。') {
          stopAcknowledgementAttempts++;
          if (stopAcknowledgementAttempts === 1) {
            firstAcknowledgementStarted.resolve();
            return firstAcknowledgement.promise;
          }
          return { messageId: '' };
        }
        if (markdown === '当前没有正在运行的任务。' || markdown === '命令已处理。') {
          return { messageId: '' };
        }
        if (markdown.includes('已被中断')) {
          return { messageId: 'unexpected_terminal_fallback' };
        }
        return { messageId: 'other_reply' };
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    let firstStopHandling: Promise<void> | void = undefined;
    try {
      await h.channel.handlers.message?.(message('om_overlap_run', 'run'));
      await waitFor(() =>
        visibleProgress.some((markdown) => markdown.includes('progress before overlapping stops')),
      );

      firstStopHandling = h.channel.handlers.message?.(
        message('om_overlap_stop_first', '/stop'),
      );
      await firstAcknowledgementStarted.promise;
      await h.channel.handlers.message?.(message('om_overlap_stop_second', '/stop'));

      stopCompletion.resolve();
      await new Promise((resolve) => setTimeout(resolve, 80));
      firstAcknowledgement.resolve({ messageId: 'first_stop_ack' });
      await firstStopHandling;
      await waitFor(
        () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      stopCompletion.resolve();
      firstAcknowledgement.resolve({ messageId: 'first_stop_ack' });
      if (firstStopHandling) await firstStopHandling;
    }

    expect(stopAcknowledgementAttempts).toBe(1);
    expect(deliveredAcknowledgements(h.channel)).toEqual(['⏹ 已请求停止当前任务。']);
    expect(
      h.channel.sent.some((entry) =>
        ((entry.content as { markdown?: string }).markdown ?? '').includes('已被中断'),
      ),
    ).toBe(false);
  });

  it('lets current-scope /stop own the only visible CoT interruption status', async () => {
    const cot = installFakeCotFetch();
    const h = await createHarness({
      cotMessages: 'brief',
      events: [{ type: 'text', delta: 'CoT progress before stop' }],
      holdOpen: true,
      stopEvent: { type: 'done', terminationReason: 'interrupted' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_stop_run', 'run'));
    await waitFor(() =>
      cot.events.some((event) => event.event_type === 'TEXT_MESSAGE_CONTENT'),
    );
    await h.channel.handlers.message?.(message('om_cot_stop_command', '/stop'));
    await waitFor(() => cot.completed.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toBe('⏹ 已请求停止当前任务。');
    expect(
      cot.events.some((event) => {
        if (event.event_type !== 'RUN_FINISHED') return false;
        return JSON.parse(event.content).status === 'interrupted';
      }),
    ).toBe(false);
    expect(cot.events.some((event) => event.event_type === 'RUN_ERROR')).toBe(false);
  });

  it('keeps abnormal Codex CoT progress out of the dedicated terminal fallback', async () => {
    const cot = installFakeCotFetch();
    const h = await createHarness({
      cotMessages: 'brief',
      events: [
        { type: 'text', delta: 'COT_PROGRESS_ALREADY_VISIBLE' },
        {
          type: 'error',
          message: 'COT_TERMINAL_FAILURE',
          terminationReason: 'failed',
        },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_failure', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(
      cot.events.some(
        (event) =>
          event.event_type === 'TEXT_MESSAGE_CONTENT' &&
          JSON.parse(event.content).delta === 'COT_PROGRESS_ALREADY_VISIBLE',
      ),
    ).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('COT_TERMINAL_FAILURE');
    expect(lastMarkdown(h.channel)).not.toContain('COT_PROGRESS_ALREADY_VISIBLE');
    expect(h.channel.sent).toHaveLength(1);
  });

  it('still sends one normal final answer after CoT progress', async () => {
    const cot = installFakeCotFetch();
    const h = await createHarness({
      cotMessages: 'brief',
      events: [
        { type: 'text', delta: 'COT_NORMAL_PROGRESS' },
        { type: 'final_text', content: 'COT_NORMAL_FINAL_ANSWER' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_normal', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(cot.events.some((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('COT_NORMAL_FINAL_ANSWER');
    expect(lastMarkdown(h.channel)).not.toContain('COT_NORMAL_PROGRESS');
    expect(h.channel.sent).toHaveLength(1);
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastMarkdown(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('keeps draining Codex after an early markdown controller write fails', async () => {
    const setContent = vi.fn(async () => {
      throw new Error('markdown controller write failed');
    });
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress before write failure' },
        { type: 'text', delta: 'more progress after write failure' },
        {
          type: 'error',
          message: 'TERMINAL_AFTER_MARKDOWN_WRITE_FAILURE',
          terminationReason: 'failed',
        },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_early_markdown_write_failure', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('TERMINAL_AFTER_MARKDOWN_WRITE_FAILURE');
    expect(lastMarkdown(h.channel)).not.toContain('progress before write failure');
  });

  it('falls back once after an early Claude card controller write fails', async () => {
    const update = vi.fn(async () => {
      throw new Error('card controller write failed');
    });
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'CLAUDE_' },
        { type: 'text', delta: 'FINAL_AFTER_EARLY_CARD_WRITE_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({ update });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_early_card_write_failure', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(update).toHaveBeenCalledTimes(1);
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain(
      'CLAUDE_FINAL_AFTER_EARLY_CARD_WRITE_FAILURE',
    );
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('sends one dedicated final reply card after progress completes in card mode', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    // Intermediate agent messages stream as progress; the final answer never
    // leaks into the progress card (it is held back for the dedicated reply).
    const progressJson = JSON.stringify(progressCards);
    expect(progressJson).toContain('progress update');
    expect(progressJson).not.toContain('FINAL_SENTINEL');

    // The terminal answer arrives as exactly one non-streaming card send.
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('progress update');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_final' });
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
  postDoneExitGraceMs?: number;
  cotMessages?: 'brief' | 'detailed';
  waitForExit?: FakeWaitForExitResult | readonly FakeWaitForExitResult[];
  holdOpen?: boolean;
  stopEvent?: AgentEvent;
  stopCompletion?: Promise<void>;
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
    agentKind: options.agentKind ?? 'codex',
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
    ...(options.messageReply ||
    options.postDoneExitGraceMs !== undefined ||
    options.cotMessages
      ? {
          preferences: {
            ...(options.messageReply ? { messageReply: options.messageReply } : {}),
            ...(options.postDoneExitGraceMs !== undefined
              ? { postDoneExitGraceMs: options.postDoneExitGraceMs }
              : {}),
            ...(options.cotMessages ? { cotMessages: options.cotMessages } : {}),
          },
        }
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
    waitForExit: options.waitForExit,
    holdOpen: options.holdOpen,
    stopEvent: options.stopEvent,
    stopCompletion: options.stopCompletion,
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

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const delivered: FakeLarkChannel['delivered'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    delivered,
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
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
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
      const attempt = { chatId, content, options };
      sent.push(attempt);
      const result = harnessOptions.send
        ? await harnessOptions.send(chatId, content, options)
        : { messageId: `sent_${sent.length}` };
      if (result.messageId.trim()) delivered.push(attempt);
      return result;
    },
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
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

function installFakeCotFetch(): {
  events: Array<{ event_type: string; content: string; timestamp: number }>;
  completed: string[];
} {
  const events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  const completed: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({
        code: 0,
        tenant_access_token: 'fake_cot_token',
        expire: 7200,
      });
    }
    if (url.includes('/message_cot/complete/')) {
      completed.push(new URL(url).searchParams.get('reason') ?? '');
      return jsonResponse({ code: 0 });
    }
    if (url.includes('/message_cot') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        events?: Array<{ event_type: string; content: string; timestamp: number }>;
      };
      events.push(...(body.events ?? []));
      return jsonResponse({ code: 0 });
    }
    if (url.includes('/message_cot') && init?.method === 'POST') {
      return jsonResponse({
        code: 0,
        data: { cot_id: 'cot_fake', message_id: 'om_cot_fake' },
      });
    }
    throw new Error(`unexpected fake CoT request: ${init?.method ?? 'GET'} ${url}`);
  });
  return { events, completed };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

function lastDeliveredMarkdown(channel: FakeLarkChannel): string {
  const content = channel.delivered.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

function deliveredAcknowledgements(channel: FakeLarkChannel): string[] {
  return channel.delivered
    .map((entry) => (entry.content as { markdown?: string }).markdown ?? '')
    .filter(
      (markdown) =>
        markdown.includes('已请求停止当前任务') ||
        markdown.includes('已被中断') ||
        markdown === '命令已处理。',
    );
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
