import { describe, expect, it } from 'vitest';
import { PiJsonlTranslator } from '../../../src/agent/pi/jsonl.js';

describe('Pi JSONL translator', () => {
  it('translates the session header into a system event', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'session', version: 3, id: 'sess-1', cwd: '/repo' })).toEqual([
      { type: 'system', sessionId: 'sess-1' },
    ]);
  });

  it('ignores structural lifecycle events with no bridge-visible payload', () => {
    const t = new PiJsonlTranslator();
    for (const type of [
      'agent_start',
      'turn_start',
      'turn_end',
      'message_start',
      'queue_update',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
      'tool_execution_update',
      'session_info_changed',
      'thinking_level_changed',
    ]) {
      expect(t.translate({ type })).toEqual([]);
    }
  });

  it('translates text and thinking deltas', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      }),
    ).toEqual([{ type: 'text', delta: 'Hello' }]);
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
      }),
    ).toEqual([{ type: 'thinking', delta: 'pondering' }]);
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start' },
      }),
    ).toEqual([]);
  });

  it('translates tool execution start/end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } }]);
    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'total 0\n' }] },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'total 0\n', isError: false }]);
  });

  it('joins multiple text content blocks in a tool result', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-2',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        isError: true,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-2', output: 'ab', isError: true }]);
  });

  it('emits usage on a completed assistant message_end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.002 } },
        },
      }),
    ).toEqual([
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
        reasoningOutputTokens: undefined,
        costUsd: 0.002,
      },
    ]);
  });

  it('ignores message_end for non-assistant roles', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'message_end', message: { role: 'user' } })).toEqual([]);
    expect(t.translate({ type: 'message_end', message: { role: 'toolResult' } })).toEqual([]);
  });

  it('translates agent_end into a normal done event, carrying the captured session id', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'session', id: 'sess-done' });
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([
      { type: 'done', sessionId: 'sess-done', terminationReason: 'normal' },
    ]);
  });

  it('translates an errored/aborted assistant message_end into a terminal error and suppresses the following agent_end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'model overloaded' },
      }),
    ).toEqual([{ type: 'error', message: 'model overloaded', terminationReason: 'failed' }]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([]);
  });

  it('falls back to a generic message when an errored message_end has no errorMessage', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }),
    ).toEqual([{ type: 'error', message: 'pi request aborted', terminationReason: 'failed' }]);
  });

  it('tracks protocol drift for unrecognized event types', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'some_future_event' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
  });

  it('does not count real-but-ignored pi event types as protocol drift', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'tool_execution_update', toolCallId: 'x', toolName: 'bash', args: {}, partialResult: {} });
    t.translate({ type: 'session_info_changed' });
    t.translate({ type: 'thinking_level_changed', level: 'high' });
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('logs and ignores extension_error without ending the stream', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({ type: 'extension_error', extensionPath: '/x.ts', error: 'boom' }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
  });

  it('emits a failed terminal event on EOF without a terminal event', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'session', id: 'sess-eof' });
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'pi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it('lets stop and timeout override EOF terminal reason', () => {
    const stopped = new PiJsonlTranslator();
    stopped.translate({ type: 'session', id: 'sess-stop' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    ]);

    const timedOut = new PiJsonlTranslator();
    timedOut.translate({ type: 'session', id: 'sess-timeout' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'done', sessionId: 'sess-timeout', terminationReason: 'timeout' },
    ]);
  });

  it('returns nothing once terminal, even for further translate calls', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'agent_end', messages: [] });
    expect(t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })).toEqual([]);
  });
});
