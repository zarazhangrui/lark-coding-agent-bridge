import { describe, expect, it } from 'vitest';
import { OpenCodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpenCode JSONL translator', () => {
  it('translates text deltas and step_finish events', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'text', part: { text: 'hello' } })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
    expect(t.translate({ type: 'text', part: { text: ' world' } })).toEqual([
      { type: 'text', delta: ' world' },
    ]);
    expect(t.translate({ type: 'step_finish' })).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores step_start and unknown event types', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'step_start' })).toEqual([]);
    expect(t.translate({ type: 'unknown.future', value: 1 })).toEqual([]);
    expect(t.translate({ type: 'step_start', session_id: 'abc' })).toEqual([]);
  });

  it('blocks translation after a terminal step_finish', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'text', part: { text: 'before' } })).toEqual([
      { type: 'text', delta: 'before' },
    ]);
    expect(t.translate({ type: 'step_finish' })).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'text', part: { text: 'after' } })).toEqual([]);
  });

  it('emits a failed terminal event on EOF without a terminal event', () => {
    const t = new OpenCodeJsonlTranslator();
    t.translate({ type: 'text', part: { text: 'partial' } });

    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'opencode stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it('lets stop and timeout override EOF terminal reason', () => {
    const stopped = new OpenCodeJsonlTranslator();
    stopped.translate({ type: 'step_start' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'done', terminationReason: 'interrupted' },
    ]);

    const timedOut = new OpenCodeJsonlTranslator();
    timedOut.translate({ type: 'step_start' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'done', terminationReason: 'timeout' },
    ]);
  });

  it('treats malformed text events as empty', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'text' })).toEqual([]);
    expect(t.translate({ type: 'text', part: {} })).toEqual([]);
    expect(t.translate({ type: 'text', part: { not_text: 'nope' } })).toEqual([]);
  });

  it('treats non-record and typeless payloads as empty', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate(null)).toEqual([]);
    expect(t.translate(42)).toEqual([]);
    expect(t.translate({})).toEqual([]);
  });
});
