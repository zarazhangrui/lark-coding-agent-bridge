import { describe, expect, it } from 'vitest';
import { translateSdkMessage } from '../../../../src/agent/claude/sdk-translate.js';

describe('translateSdkMessage', () => {
  it('maps system/init to a system event', () => {
    expect(
      translateSdkMessage({ type: 'system', subtype: 'init', session_id: 's1', cwd: '/w', model: 'claude-x' }),
    ).toEqual([{ type: 'system', sessionId: 's1', cwd: '/w', model: 'claude-x' }]);
  });

  it('maps assistant content blocks to text/thinking/tool_use', () => {
    expect(
      translateSdkMessage({
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'thinking', delta: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('maps user tool_result blocks', () => {
    expect(
      translateSdkMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
      }),
    ).toEqual([{ type: 'tool_result', id: 't1', output: 'ok', isError: false }]);
  });

  it('maps user tool_result blocks with undefined content to an empty-string output', () => {
    expect(
      translateSdkMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: undefined, is_error: false }] },
      }),
    ).toEqual([{ type: 'tool_result', id: 't1', output: '', isError: false }]);
  });

  it('maps a successful result to usage + done', () => {
    expect(
      translateSdkMessage({
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      }),
    ).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 20, cachedInputTokens: 5, costUsd: 0.02 },
      { type: 'done', sessionId: 's1', terminationReason: 'normal' },
    ]);
  });

  it('maps an error result to an error event', () => {
    const out = translateSdkMessage({ type: 'result', subtype: 'error_during_execution', session_id: 's1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it('maps an assistant error field to an error event', () => {
    const out = translateSdkMessage({ type: 'assistant', error: 'billing_error', session_id: 's1', message: { content: [] } });
    expect(out[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((out[0] as { message: string }).message).toContain('billing_error');
  });

  it('maps permission_denied to a notice event', () => {
    expect(
      translateSdkMessage({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tu-9',
        decision_reason: 'classifier judged the command destructive',
        message: 'Permission denied',
      }),
    ).toEqual([
      { type: 'notice', text: '工具 Bash 被自动拒绝：classifier judged the command destructive' },
    ]);
  });

  it('falls back to message when decision_reason is absent', () => {
    const out = translateSdkMessage({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Write',
      tool_use_id: 'tu-10',
      message: 'Permission denied',
    });
    expect(out).toEqual([{ type: 'notice', text: '工具 Write 被自动拒绝：Permission denied' }]);
  });

  it('ignores unrelated message types', () => {
    expect(translateSdkMessage({ type: 'stream_event' })).toEqual([]);
    expect(translateSdkMessage(null)).toEqual([]);
  });
});
