import { describe, expect, it } from 'vitest';
import { createCodexTranslator } from '../../src/agent/codex/stream-json';

describe('createCodexTranslator', () => {
  it('maps Codex JSONL events into bridge agent events', () => {
    const translator = createCodexTranslator();
    const events = [
      ...translator.translate({
        type: 'thread.started',
        thread_id: '019e5753-11f2-70a2-a9c7-c76719468b1b',
      }),
      ...translator.translate({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'OK' },
      }),
      ...translator.translate({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ];

    expect(events).toEqual([
      { type: 'system', sessionId: '019e5753-11f2-70a2-a9c7-c76719468b1b' },
      { type: 'text', delta: 'OK' },
      { type: 'usage', inputTokens: 10, outputTokens: 2 },
      { type: 'done', sessionId: '019e5753-11f2-70a2-a9c7-c76719468b1b' },
    ]);
  });

  it('maps command execution events into tool events', () => {
    const translator = createCodexTranslator();
    const events = [
      ...translator.translate({
        type: 'item.started',
        item: { id: 'cmd_1', type: 'command_execution', command: 'npm test' },
      }),
      ...translator.translate({
        type: 'item.completed',
        item: {
          id: 'cmd_1',
          type: 'command_execution',
          aggregated_output: 'failed',
          exit_code: 1,
        },
      }),
    ];

    expect(events).toEqual([
      { type: 'tool_use', id: 'cmd_1', name: 'shell', input: { command: 'npm test' } },
      { type: 'tool_result', id: 'cmd_1', output: 'failed', isError: true },
    ]);
  });
});
