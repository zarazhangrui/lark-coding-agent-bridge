import { describe, expect, it } from 'vitest';
import { KimiStreamTranslator } from '../../../src/agent/kimi/stream.js';

describe('KimiStreamTranslator', () => {
  it('ignores system.version meta and reports the session id from resume_hint', () => {
    const t = new KimiStreamTranslator();
    expect(
      t.translate({ role: 'meta', type: 'system.version', version: '0.36.1' }),
    ).toEqual([]);
    expect(
      t.translate({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session_abc',
        command: 'kimi -r session_abc',
      }),
    ).toEqual([{ type: 'system', sessionId: 'session_abc' }]);
    // A repeated hint for the same session is not re-reported.
    expect(
      t.translate({ role: 'meta', type: 'session.resume_hint', session_id: 'session_abc' }),
    ).toEqual([]);
  });

  it('holds the last assistant message back and promotes it on finish(normal)', () => {
    const t = new KimiStreamTranslator();
    expect(t.translate({ role: 'assistant', content: 'progress note' })).toEqual([]);
    // A following assistant message demotes the previous one to streamed text.
    expect(t.translate({ role: 'assistant', content: 'final answer' })).toEqual([
      { type: 'text', delta: 'progress note' },
    ]);
    expect(t.finish('normal')).toEqual([
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });

  it('flushes progress text before the tool calls it announces', () => {
    const t = new KimiStreamTranslator();
    const events = t.translate({
      role: 'assistant',
      content: 'let me run that',
      tool_calls: [
        {
          type: 'function',
          id: 'Bash_0',
          function: { name: 'Bash', arguments: '{"command":"echo hi"}' },
        },
      ],
    });
    expect(events).toEqual([
      { type: 'text', delta: 'let me run that' },
      { type: 'tool_use', id: 'Bash_0', name: 'Bash', input: { command: 'echo hi' } },
    ]);
  });

  it('parses tool results and keeps unparseable arguments as raw strings', () => {
    const t = new KimiStreamTranslator();
    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 'X_1', function: { name: 'Read', arguments: '{nope' } },
        ],
      }),
    ).toEqual([{ type: 'tool_use', id: 'X_1', name: 'Read', input: '{nope' }]);
    expect(t.translate({ role: 'tool', tool_call_id: 'X_1', content: 'file body' })).toEqual([
      { type: 'tool_result', id: 'X_1', output: 'file body', isError: false },
    ]);
  });

  it('treats meta retry notices as non-terminal errors and ends failed streams in error', () => {
    const t = new KimiStreamTranslator();
    expect(
      t.translate({
        role: 'meta',
        type: 'turn.step.retrying',
        error_name: 'APIConnectionError',
        error_message: 'Connection error.',
      }),
    ).toEqual([]);
    const events = t.finish();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
    });
    expect((events[0] as { message: string }).message).toContain('Connection error.');
  });

  it('ends interrupted runs with done and pending text flushed', () => {
    const t = new KimiStreamTranslator();
    t.translate({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_xyz',
    });
    t.translate({ role: 'assistant', content: 'partial' });
    expect(t.finish('interrupted')).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'done', sessionId: 'session_xyz', terminationReason: 'interrupted' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
    // Nothing more is emitted after a terminal event.
    expect(t.translate({ role: 'assistant', content: 'late' })).toEqual([]);
  });
});
