import { describe, expect, it } from 'vitest';
import { OpenCodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpenCode JSONL translator', () => {
  it('captures sessionID from any OpenCode event', () => {
    const translator = new OpenCodeJsonlTranslator();

    expect(translator.translate({ type: 'step_start', sessionID: 'ses_upper' })).toEqual([
      { type: 'system', sessionId: 'ses_upper' },
    ]);
  });

  it('keeps tool-calls step_finish non-terminal and waits for final stop', () => {
    const translator = new OpenCodeJsonlTranslator();

    expect(
      translator.translate({
        type: 'step_finish',
        sessionID: 'ses_tool',
        reason: 'tool-calls',
      }),
    ).toEqual([{ type: 'system', sessionId: 'ses_tool' }]);
    expect(translator.terminalEmitted()).toBe(false);
    expect(translator.translate({ type: 'text', part: { text: 'after tool' } })).toEqual([
      { type: 'text', delta: 'after tool' },
    ]);
    expect(translator.translate({ type: 'step_finish', reason: 'stop' })).toEqual([
      { type: 'done', terminationReason: 'normal', sessionId: 'ses_tool' },
    ]);
  });

  it('translates text and completed tool_use events', () => {
    const translator = new OpenCodeJsonlTranslator();

    expect(translator.translate({ type: 'text', text: 'hello' })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
    expect(
      translator.translate({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_1',
          state: {
            status: 'completed',
            input: { command: 'pwd' },
            output: '/repo',
          },
        },
      }),
    ).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'call_1', output: '/repo', isError: false },
    ]);
  });

  it('reports early EOF before a terminal event', () => {
    const translator = new OpenCodeJsonlTranslator();

    expect(translator.finish()).toEqual([
      {
        type: 'error',
        message: 'opencode stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
  });

  it('emits interrupted done with the captured session id', () => {
    const translator = new OpenCodeJsonlTranslator();
    translator.translate({ type: 'session.started', session_id: 'ses_snake' });

    expect(translator.finish('interrupted')).toEqual([
      { type: 'done', terminationReason: 'interrupted', sessionId: 'ses_snake' },
    ]);
  });
});
