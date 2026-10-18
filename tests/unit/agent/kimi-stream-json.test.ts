import { describe, expect, it } from 'vitest';
import { KimiStreamTranslator } from '../../../src/agent/kimi/stream-json.js';

describe('Kimi stream-json translator', () => {
  it('records the leading system.version meta without emitting an event', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.kimiVersion()).toBeUndefined();
    expect(
      translator.translate({ role: 'meta', type: 'system.version', version: '2.2.0' }),
    ).toEqual([]);

    expect(translator.kimiVersion()).toBe('2.2.0');
    expect(translator.terminalEmitted()).toBe(false);
  });

  it('translates assistant content into text deltas', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.translate({ role: 'assistant', content: 'hello' })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
    expect(translator.translate({ role: 'assistant', content: '' })).toEqual([]);
    expect(translator.translate({ role: 'assistant' })).toEqual([]);
  });

  it('parses tool_calls arguments JSON into the tool_use input', () => {
    const translator = new KimiStreamTranslator();

    expect(
      translator.translate({
        role: 'assistant',
        tool_calls: [
          {
            id: 'tool_1',
            function: { name: 'Bash', arguments: '{"command":"ls"}' },
          },
        ],
      }),
    ).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('passes malformed tool arguments through as the raw string', () => {
    const translator = new KimiStreamTranslator();

    expect(
      translator.translate({
        role: 'assistant',
        tool_calls: [
          {
            id: 'tool_1',
            function: { name: 'Read', arguments: '{not json' },
          },
        ],
      }),
    ).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: '{not json' },
    ]);
  });

  it('skips tool calls missing an id or function name', () => {
    const translator = new KimiStreamTranslator();

    expect(
      translator.translate({
        role: 'assistant',
        tool_calls: [
          { function: { name: 'Bash', arguments: '{}' } },
          { id: 'tool_2', function: { arguments: '{}' } },
          { id: 'tool_3' },
          'not-a-record',
        ],
      }),
    ).toEqual([]);
  });

  it('translates tool results for string and non-string content', () => {
    const translator = new KimiStreamTranslator();

    expect(
      translator.translate({ role: 'tool', tool_call_id: 'tool_1', content: 'out' }),
    ).toEqual([
      { type: 'tool_result', id: 'tool_1', output: 'out', isError: false },
    ]);
    expect(
      translator.translate({
        role: 'tool',
        tool_call_id: 'tool_2',
        content: [{ type: 'text', text: 'structured' }],
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'tool_2',
        output: JSON.stringify([{ type: 'text', text: 'structured' }]),
        isError: false,
      },
    ]);
    expect(translator.translate({ role: 'tool', content: 'no id' })).toEqual([]);
  });

  it('translates session.resume_hint into system then done and turns terminal', () => {
    const translator = new KimiStreamTranslator();

    expect(
      translator.translate({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session_x',
        command: 'kimi -r session_x',
      }),
    ).toEqual([
      { type: 'system', sessionId: 'session_x' },
      { type: 'done', sessionId: 'session_x', terminationReason: 'normal' },
    ]);
    expect(translator.terminalEmitted()).toBe(true);
    expect(translator.translate({ role: 'assistant', content: 'late' })).toEqual([]);
  });

  it('emits only done when the resume_hint carries no session_id', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.translate({ role: 'meta', type: 'session.resume_hint' })).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores unknown roles, meta types, and non-record input', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.translate(null)).toEqual([]);
    expect(translator.translate('string')).toEqual([]);
    expect(translator.translate([{ role: 'assistant' }])).toEqual([]);
    expect(translator.translate({ role: 'user', content: 'hi' })).toEqual([]);
    expect(translator.translate({ role: 'meta', type: 'other' })).toEqual([]);
  });

  it('falls back to a done event without sessionId when the stream ends interrupted', () => {
    const translator = new KimiStreamTranslator();
    translator.translate({ role: 'assistant', content: 'partial' });

    expect(translator.finish('interrupted')).toEqual([
      { type: 'done', terminationReason: 'interrupted' },
    ]);
    expect(translator.terminalEmitted()).toBe(true);
  });

  it('keeps a sessionId seen earlier in the stream on the finish fallback', () => {
    const translator = new KimiStreamTranslator();
    translator.translate({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_x',
    });
    // terminal after the hint; finish must be a no-op.
    expect(translator.finish('interrupted')).toEqual([]);
  });

  it('reports a failed terminal when the stream ends before any terminal event', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.finish('failed')).toEqual([
      {
        type: 'error',
        message: 'kimi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('is a no-op after terminal state', () => {
    const translator = new KimiStreamTranslator();
    translator.finish('normal');

    expect(translator.finish('interrupted')).toEqual([]);
    expect(translator.fail('boom')).toEqual([]);
    expect(translator.translate({ role: 'assistant', content: 'late' })).toEqual([]);
  });

  it('emits a truncated error on fail and turns terminal', () => {
    const translator = new KimiStreamTranslator();

    expect(translator.fail('boom')).toEqual([
      { type: 'error', message: 'boom', terminationReason: 'failed' },
    ]);
    expect(translator.terminalEmitted()).toBe(true);
    expect(translator.translate({ role: 'assistant', content: 'late' })).toEqual([]);

    const long = new KimiStreamTranslator();
    const [event] = long.fail('x'.repeat(5000));
    expect(event).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((event as { message: string }).message).toHaveLength(4096);
  });
});
