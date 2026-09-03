import { describe, expect, it } from 'vitest';
import { MimoJsonlTranslator } from '../../../src/agent/mimo/jsonl.js';

describe('MimoJsonlTranslator', () => {
  it('captures sessionId from step_start and emits a system event once', () => {
    const t = new MimoJsonlTranslator();
    expect(t.translate({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } })).toEqual([
      { type: 'system', sessionId: 'ses_a' },
    ]);
    expect(t.translate({ type: 'step_start', sessionID: 'ses_a', part: { type: 'step-start' } })).toEqual([]);
  });

  it('streams text deltas and accumulates them for final_text', () => {
    const t = new MimoJsonlTranslator();
    expect(t.translate({ type: 'text', part: { type: 'text', text: '你好' } })).toEqual([
      { type: 'text', delta: '你好' },
    ]);
    expect(t.translate({ type: 'text', part: { type: 'text', text: '世界' } })).toEqual([
      { type: 'text', delta: '世界' },
    ]);
    expect(t.finish('normal')).toEqual([
      { type: 'final_text', content: '你好世界' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('translates reasoning to thinking', () => {
    const t = new MimoJsonlTranslator();
    expect(t.translate({ type: 'reasoning', part: { type: 'reasoning', text: '思考中' } })).toEqual([
      { type: 'thinking', delta: '思考中' },
    ]);
  });

  it('resolves a completed tool call to tool_use + tool_result', () => {
    const t = new MimoJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'write',
          callID: 'call_1',
          state: {
            status: 'completed',
            input: { file_path: '/tmp/a.txt' },
            output: 'Wrote file successfully.',
          },
        },
      }),
    ).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'write', input: { file_path: '/tmp/a.txt' } },
      { type: 'tool_result', id: 'call_1', output: 'Wrote file successfully.', isError: false },
    ]);
  });

  it('marks errored tool calls as isError', () => {
    const t = new MimoJsonlTranslator();
    const events = t.translate({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_2',
        state: { status: 'error', input: { command: 'false' }, output: 'boom' },
      },
    });
    expect(events).toEqual([
      { type: 'tool_use', id: 'call_2', name: 'bash', input: { command: 'false' } },
      { type: 'tool_result', id: 'call_2', output: 'boom', isError: true },
    ]);
  });

  it('translates step_finish tokens into a usage event', () => {
    const t = new MimoJsonlTranslator();
    expect(
      t.translate({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { total: 100, input: 80, output: 20, reasoning: 5, cache: { read: 3 } },
          cost: 0,
        },
      }),
    ).toEqual([
      {
        type: 'usage',
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 3,
        reasoningOutputTokens: 5,
      },
    ]);
  });

  it('surfaces non-terminal error events at finish, not as stream errors', () => {
    const t = new MimoJsonlTranslator();
    expect(
      t.translate({ type: 'error', error: { name: 'APIError', data: { message: 'Invalid token' } } }),
    ).toEqual([]);
    expect(t.fail('mimo exited with code 1')).toEqual([
      {
        type: 'error',
        message: 'mimo exited with code 1: Invalid token',
        terminationReason: 'failed',
      },
    ]);
  });

  it('emits done with interrupted reason after stop', () => {
    const t = new MimoJsonlTranslator();
    expect(t.finish('interrupted')).toEqual([
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });

  it('skips non-JSON lines and unknown event types with drift tracking', () => {
    const t = new MimoJsonlTranslator();
    expect(t.translate('Database migration complete.')).toEqual([]);
    expect(t.translate({ type: 'weird_event' })).toEqual([]);
    expect(t.translate({})).toEqual([]);
    const drift = t.protocolDrift();
    expect(drift.unknownEvents).toBe(1);
    expect(drift.anomalies).toBeGreaterThan(0);
  });

  it('is terminal after finish or fail', () => {
    const t = new MimoJsonlTranslator();
    t.finish('normal');
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'text', part: { type: 'text', text: 'late' } })).toEqual([]);

    const t2 = new MimoJsonlTranslator();
    t2.fail('boom');
    expect(t2.finish('normal')).toEqual([]);
  });
});
