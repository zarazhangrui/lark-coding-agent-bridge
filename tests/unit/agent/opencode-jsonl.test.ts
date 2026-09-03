import { describe, expect, it } from 'vitest';
import { OpencodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpencodeJsonlTranslator', () => {
  it('emits a system event carrying sessionId from the first envelope', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'text', timestamp: 1, sessionID: 'sess-1', part: { type: 'text', text: 'hi', time: { end: 2 } } })).toEqual([
      { type: 'system', sessionId: 'sess-1' },
    ]);
  });

  it('buffers text and emits final_text on finish', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'hello', time: { end: 2 } } });
    expect(t.finish('interrupted')).toEqual([
      { type: 'final_text', content: 'hello' },
      { type: 'done', sessionId: 's', terminationReason: 'interrupted' },
    ]);
  });

  it('flushes buffered text before a later tool_use', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'first', time: { end: 2 } } });
    expect(
      t.translate({
        type: 'tool_use',
        timestamp: 3,
        sessionID: 's',
        part: { id: 't1', type: 'tool', tool: 'bash', state: { status: 'completed' }, output: 'ok' },
      }),
    ).toEqual([
      { type: 'text', delta: 'first' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { output: 'ok' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    ]);
  });

  it('emits tool_use + tool_result(isError=true) when state.error is present', () => {
    const t = new OpencodeJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_use',
        timestamp: 1,
        sessionID: 's',
        part: { id: 't2', type: 'tool', tool: 'bash', state: { status: 'error', error: 'boom' } },
      }),
    ).toEqual([
      { type: 'tool_use', id: 't2', name: 'bash', input: { output: 'boom' } },
      { type: 'tool_result', id: 't2', output: 'boom', isError: true },
    ]);
  });

  it('emits thinking delta for reasoning events', () => {
    const t = new OpencodeJsonlTranslator();
    expect(
      t.translate({ type: 'reasoning', timestamp: 1, sessionID: 's', part: { type: 'reasoning', text: 'hmm', time: { end: 2 } } }),
    ).toEqual([{ type: 'thinking', delta: 'hmm' }]);
  });

  it('records a non-terminal error and surfaces it on finish()', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'error', timestamp: 1, sessionID: 's', error: { name: 'X', message: 'oops' } });
    expect(t.finish('failed')).toEqual([
      { type: 'error', message: 'opencode stream ended before a terminal event: oops', terminationReason: 'failed' },
    ]);
  });

  it('ignores unknown event types but counts drift', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'mystery', timestamp: 1, sessionID: 's' })).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(1);
  });

  it('does not emit after terminal', () => {
    const t = new OpencodeJsonlTranslator();
    t.finish('normal');
    expect(t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'x', time: { end: 2 } } })).toEqual([]);
  });

  it('emits done with terminationReason normal on finish("normal")', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'hello', time: { end: 2 } } });
    expect(t.finish('normal')).toEqual([
      { type: 'final_text', content: 'hello' },
      { type: 'done', sessionId: 's', terminationReason: 'normal' },
    ]);
  });
});
