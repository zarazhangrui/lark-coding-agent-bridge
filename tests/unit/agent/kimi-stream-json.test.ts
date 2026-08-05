import { describe, expect, it } from 'vitest';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/stream-json.js';

describe('Kimi JSONL translator', () => {
  it('captures the resume hint session id from a meta event', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session_abc',
        command: 'kimi -r ...',
      }),
    ).toEqual([{ type: 'system', sessionId: 'session_abc' }]);
  });

  it('accepts the camelCase sessionId spelling as well', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({ role: 'meta', type: 'session.resume_hint', sessionId: 'session_x' }),
    ).toEqual([{ type: 'system', sessionId: 'session_x' }]);
  });

  it('ignores the version banner and flags unknown meta types as drift', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'meta', type: 'system.version', version: '0.33.0' })).toEqual([]);
    expect(t.translate({ role: 'meta', type: 'future.thing' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
  });

  it('translates assistant tool calls into tool_use events with parsed arguments', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'tool_1',
            function: { name: 'Read', arguments: '{"path":"probe.txt"}' },
          },
        ],
      }),
    ).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'probe.txt' } },
    ]);
  });

  it('passes non-JSON tool arguments through verbatim', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [
          {
            id: 'tool_2',
            function: { name: 'Shell', arguments: 'not json' },
          },
        ],
      }),
    ).toEqual([{ type: 'tool_use', id: 'tool_2', name: 'Shell', input: 'not json' }]);
  });

  it('counts a tool call without an id as an anomaly', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [{ function: { name: 'Read', arguments: '{}' } }],
      }),
    ).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 1 });
  });

  it('matches tool results to their calls by tool_call_id', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'tool',
        tool_call_id: 'tool_1',
        content: 'file contents',
      }),
    ).toEqual([
      { type: 'tool_result', id: 'tool_1', output: 'file contents', isError: false },
    ]);
    expect(t.translate({ role: 'tool', content: 'no id' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 1 });
  });

  it('treats a message announced twice as one message', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'assistant', content: 'hello world' })).toEqual([]);
    expect(t.translate({ role: 'assistant', content: 'hello world' })).toEqual([]);
    expect(t.finish('normal')).toEqual([
      { type: 'text', delta: 'hello world' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('streams earlier assistant messages as text deltas and reserves the last one', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'assistant', content: 'progress one' })).toEqual([]);
    expect(t.translate({ role: 'assistant', content: 'progress two' })).toEqual([
      { type: 'text', delta: 'progress one' },
    ]);
    expect(
      t.translate({
        role: 'tool',
        tool_call_id: 'tool_1',
        content: 'result',
      }),
    ).toEqual([
      { type: 'text', delta: 'progress two' },
      { type: 'tool_result', id: 'tool_1', output: 'result', isError: false },
    ]);
    expect(t.translate({ role: 'assistant', content: 'final answer' })).toEqual([]);
    expect(t.finish('normal')).toEqual([
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('emits a done event with the session id on a normal finish', () => {
    const t = new KimiJsonlTranslator();
    t.translate({ role: 'meta', type: 'session.resume_hint', session_id: 'session_abc' });
    expect(t.finish('normal')).toEqual([
      { type: 'done', sessionId: 'session_abc', terminationReason: 'normal' },
    ]);
  });

  it('lets interrupted and timeout finishes flush the partial answer', () => {
    const stopped = new KimiJsonlTranslator();
    stopped.translate({ role: 'assistant', content: 'half answer' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'text', delta: 'half answer' },
      { type: 'done', terminationReason: 'interrupted' },
    ]);

    const timedOut = new KimiJsonlTranslator();
    timedOut.translate({ role: 'assistant', content: 'half answer' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'text', delta: 'half answer' },
      { type: 'done', terminationReason: 'timeout' },
    ]);
  });

  it('emits a failed terminal event on finish("failed") without a terminal event', () => {
    const t = new KimiJsonlTranslator();
    expect(t.finish('failed')).toEqual([
      {
        type: 'error',
        message: 'kimi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('reports a fail() message verbatim', () => {
    const t = new KimiJsonlTranslator();
    expect(t.fail('kimi exited with code 1')).toEqual([
      { type: 'error', message: 'kimi exited with code 1', terminationReason: 'failed' },
    ]);
  });

  it('stays terminal after finish or fail', () => {
    const t = new KimiJsonlTranslator();
    t.translate({ role: 'assistant', content: 'done' });
    t.finish('normal');
    expect(t.translate({ role: 'assistant', content: 'too late' })).toEqual([]);
    expect(t.finish('normal')).toEqual([]);
    expect(t.fail('late error')).toEqual([]);
  });

  it('tracks protocol drift while ignoring unknown and anomalous events', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'future', data: 1 })).toEqual([]);
    expect(t.translate({ type: 'not-a-kimi-event' })).toEqual([]);
    expect(t.translate({ role: 'meta', type: 'session.resume_hint' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 2 });
  });
});
