import { describe, expect, it } from 'vitest';
import { translateGrokEvent } from '../../../src/agent/grok/stream-json.js';

describe('Grok streaming-messages-json translator', () => {
  it('reuses the Messages stream-json shape for init, text, and success', () => {
    expect([
      ...translateGrokEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'grok-4.6',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'grok-4.6' },
    ]);

    expect([
      ...translateGrokEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ]).toEqual([{ type: 'text', delta: 'hello' }]);

    expect([
      ...translateGrokEvent({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 1 },
        total_cost_usd: 0.01,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 4, cachedInputTokens: 1, costUsd: 0.01 },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
  });

  it('maps error result subtypes to a terminal error event', () => {
    expect([
      ...translateGrokEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'boom',
        session_id: 'sess-1',
      }),
    ]).toEqual([
      { type: 'error', message: 'boom', terminationReason: 'failed' },
    ]);
  });
});
