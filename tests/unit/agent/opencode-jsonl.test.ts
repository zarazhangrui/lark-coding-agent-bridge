import { describe, expect, it } from 'vitest';
import { OpenCodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpenCode JSONL translator', () => {
  it('translates text deltas, step_finish is non-terminal', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'text', part: { text: 'hello' } })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
    expect(t.translate({ type: 'text', part: { text: ' world' } })).toEqual([
      { type: 'text', delta: ' world' },
    ]);
    expect(t.translate({ type: 'step_finish' })).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.finish()).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores step_start and unknown event types', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'step_start' })).toEqual([]);
    expect(t.translate({ type: 'unknown.future', value: 1 })).toEqual([]);
    expect(t.translate({ type: 'step_start', session_id: 'abc' })).toEqual([]);
  });

  it('allows text events after step_finish (multi-step run)', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'text', part: { text: 'before' } })).toEqual([
      { type: 'text', delta: 'before' },
    ]);
    expect(t.translate({ type: 'step_finish' })).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.translate({ type: 'step_start' })).toEqual([]);
    expect(t.translate({ type: 'text', part: { text: 'after' } })).toEqual([
      { type: 'text', delta: 'after' },
    ]);
    expect(t.translate({ type: 'step_finish' })).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
  });

  it('emits a normal done event on clean EOF without errors', () => {
    const t = new OpenCodeJsonlTranslator();
    t.translate({ type: 'text', part: { text: 'partial' } });

    expect(t.finish()).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
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

  it('translates completed tool_use events into tool_use and tool_result', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(
      t.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'write',
          callID: 'call-123',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/test.txt', content: '你好！' },
            output: 'Wrote file successfully.',
            metadata: { filepath: '/tmp/test.txt' },
            title: 'tmp/test.txt',
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'call-123',
        name: 'write',
        input: { filePath: '/tmp/test.txt', content: '你好！' },
      },
      {
        type: 'tool_result',
        id: 'call-123',
        output: 'Wrote file successfully.',
        isError: false,
      },
    ]);
  });

  it('emits only tool_use when tool_use event is not yet completed', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(
      t.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call-456',
          state: {
            status: 'in_progress',
            input: { command: 'ls' },
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'call-456',
        name: 'bash',
        input: { command: 'ls' },
      },
    ]);
  });

  it('falls back to tool name when callID is missing', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(
      t.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/a.txt' },
            output: 'file contents',
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'read',
        name: 'read',
        input: { filePath: '/tmp/a.txt' },
      },
      {
        type: 'tool_result',
        id: 'read',
        output: 'file contents',
        isError: false,
      },
    ]);
  });

  it('uses title as fallback output when state.output is missing', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(
      t.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'write',
          callID: 'call-789',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/b.txt', content: 'data' },
            title: 'tmp/b.txt',
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'call-789',
        name: 'write',
        input: { filePath: '/tmp/b.txt', content: 'data' },
      },
      {
        type: 'tool_result',
        id: 'call-789',
        output: 'tmp/b.txt',
        isError: false,
      },
    ]);
  });

  it('ignores malformed tool_use events safely', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate({ type: 'tool_use' })).toEqual([]);
    expect(t.translate({ type: 'tool_use', part: null })).toEqual([]);
    expect(t.translate({ type: 'tool_use', part: { type: 'unknown' } })).toEqual([]);
    expect(t.translate({ type: 'tool_use', part: { type: 'tool' } })).toEqual([]);
    expect(t.translate({ type: 'tool_use', part: { type: 'tool', tool: '' } })).toEqual(
      [],
    );
  });

  it('passes text through after tool step finishes (multi-step run)', () => {
    const t = new OpenCodeJsonlTranslator();

    t.translate({ type: 'step_start' });
    t.translate({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'write',
        callID: 'c1',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/x' },
          output: 'ok',
        },
      },
    });
    t.translate({ type: 'step_finish' });

    expect(t.terminalEmitted()).toBe(false);

    t.translate({ type: 'step_start' });
    expect(
      t.translate({ type: 'text', part: { text: 'File created at /tmp/x' } }),
    ).toEqual([{ type: 'text', delta: 'File created at /tmp/x' }]);
    t.translate({ type: 'step_finish' });

    expect(t.terminalEmitted()).toBe(false);
    expect(t.finish()).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });
});
