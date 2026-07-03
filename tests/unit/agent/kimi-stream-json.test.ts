import { describe, expect, it } from 'vitest';
import { KimiJsonlTranslator } from '../../../src/agent/kimi/stream-json.js';

describe('Kimi JSONL translator', () => {
  it('translates assistant text, tool calls, tool results, and session hints', () => {
    const t = new KimiJsonlTranslator();

    expect(t.translate({ role: 'assistant', content: 'hello' })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);

    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'tool-1',
            function: { name: 'Read', arguments: '{"path":"/repo/package.json"}' },
          },
        ],
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { path: '/repo/package.json' },
      },
    ]);

    expect(
      t.translate({
        role: 'tool',
        tool_call_id: 'tool-1',
        content: '{"name":"my-pkg"}',
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'tool-1',
        output: '{"name":"my-pkg"}',
        isError: false,
      },
    ]);

    expect(
      t.translate({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session-abc',
        command: 'kimi -r session-abc',
        content: 'To resume this session',
      }),
    ).toEqual([{ type: 'system', sessionId: 'session-abc' }]);
  });

  it('parses tool arguments as raw string when JSON parsing fails', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'tool-2',
            function: { name: 'Bash', arguments: 'not-json' },
          },
        ],
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'tool-2',
        name: 'Bash',
        input: 'not-json',
      },
    ]);
  });

  it('stringifies non-string tool result content', () => {
    const t = new KimiJsonlTranslator();
    expect(
      t.translate({
        role: 'tool',
        tool_call_id: 'tool-3',
        content: { key: 'value' },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'tool-3',
        output: '{"key":"value"}',
        isError: false,
      },
    ]);
  });

  it('emits done event with session id on normal finish', () => {
    const t = new KimiJsonlTranslator();
    t.translate({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session-xyz',
      command: 'kimi -r session-xyz',
      content: 'resume hint',
    });
    expect(t.finish('normal')).toEqual([
      { type: 'done', sessionId: 'session-xyz', terminationReason: 'normal' },
    ]);
  });

  it('emits error event on failed finish', () => {
    const t = new KimiJsonlTranslator();
    expect(t.finish('failed')).toEqual([
      {
        type: 'error',
        message: 'kimi stream ended without a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('ignores unknown meta events', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'meta', type: 'unknown' })).toEqual([]);
  });

  it('ignores non-record input and counts anomalies', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate('not-an-object')).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 1 });
  });

  it('ignores unknown roles and counts unknown events', () => {
    const t = new KimiJsonlTranslator();
    expect(t.translate({ role: 'user', content: 'hi' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
  });

  it('does not emit events after terminal finish', () => {
    const t = new KimiJsonlTranslator();
    t.finish('normal');
    expect(t.translate({ role: 'assistant', content: 'late' })).toEqual([]);
  });
});
