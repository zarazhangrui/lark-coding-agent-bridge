import { describe, expect, it } from 'vitest';
import { PiJsonTranslator } from '../../../src/agent/pi/stream-json.js';

describe('Pi NDJSON translator', () => {
  it('translates session header, deltas, tool execution, usage, and completion', () => {
    const t = new PiJsonTranslator();

    // session header is emitted first and is NOT part of pi's AgentEvent union
    expect(t.translate({ type: 'session', id: 'sess-1', cwd: '/repo' })).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo' },
    ]);

    // lifecycle markers are dropped
    expect(t.translate({ type: 'agent_start' })).toEqual([]);
    expect(t.translate({ type: 'turn_start' })).toEqual([]);
    expect(t.translate({ type: 'message_start', message: {} })).toEqual([]);
    expect(t.translate({ type: 'turn_end', message: {}, toolResults: [] })).toEqual([]);

    expect(
      t.translate({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
      }),
    ).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(
      t.translate({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hm' },
      }),
    ).toEqual([{ type: 'thinking', delta: 'hm' }]);

    // tool_use comes from tool_execution_start (authoritative; toolcall_end dropped)
    expect(
      t.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'pwd' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } }]);

    // tool_execution_update degrades to a tagged text delta (decision B)
    expect(
      t.translate({
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: '/repo' }] },
      }),
    ).toEqual([{ type: 'text', delta: '[tool:bash] /repo\n' }]);

    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '/repo\n' }] },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: '/repo\n', isError: false }]);

    // usage synthesized from message_end (decision C); reasoning may be absent
    expect(
      t.translate({
        type: 'message_end',
        message: { usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 } },
      })[0],
    ).toMatchObject({
      type: 'usage',
      inputTokens: 12,
      outputTokens: 34,
      cachedInputTokens: 5,
    });

    // agent_end terminates and carries the captured sessionId
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
  });

  it('drops toolcall_end to avoid duplicate tool_use ids', () => {
    const t = new PiJsonTranslator();
    expect(
      t.translate({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
        },
      }),
    ).toEqual([]);
  });

  it('keeps assistant errors non-terminal so retries can continue', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-retry' });
    expect(
      t.translate({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {
          type: 'error',
          reason: 'aborted',
          error: { errorMessage: 'rate limited' },
        },
      }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([
      { type: 'done', sessionId: 'sess-retry', terminationReason: 'normal' },
    ]);
  });

  it('tracks protocol drift on unknown events', () => {
    const t = new PiJsonTranslator();
    expect(t.translate({ type: 'future.event' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
  });

  it('emits a failed terminal event on EOF without agent_end', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'pi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it('lets stop/timeout synthesize a done event (SIGTERM does not rely on pi flush)', () => {
    const stopped = new PiJsonTranslator();
    stopped.translate({ type: 'session', id: 'sess-stop' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    ]);

    const timedOut = new PiJsonTranslator();
    timedOut.translate({ type: 'session', id: 'sess-timeout' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'done', sessionId: 'sess-timeout', terminationReason: 'timeout' },
    ]);
  });
});
