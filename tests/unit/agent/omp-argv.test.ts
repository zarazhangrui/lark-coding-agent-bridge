import { describe, expect, it } from 'vitest';
import { buildOmpArgs, OMP_APPROVAL_MODE } from '../../../src/agent/omp/argv';

describe('OMP argv', () => {
  it('runs the RPC transport with yolo approval and the bridge system prompt file', () => {
    expect(
      buildOmpArgs({ systemPromptFile: '/tmp/append-system-prompt.md' }),
    ).toEqual([
      '--mode',
      'rpc',
      '--no-title',
      '--approval-mode',
      OMP_APPROVAL_MODE,
      '--append-system-prompt',
      '/tmp/append-system-prompt.md',
    ]);
  });

  it('appends resume and model after the base contract', () => {
    const args = buildOmpArgs({
      systemPromptFile: '/tmp/prompt.md',
      sessionId: '01a0-session',
      model: 'workbuddy/cn:deepseek-v4.1-flash',
    });

    expect(args.slice(-4)).toEqual([
      '--resume',
      '01a0-session',
      '--model',
      'workbuddy/cn:deepseek-v4.1-flash',
    ]);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
  });

  it('honors an explicit approval mode override', () => {
    const args = buildOmpArgs({
      systemPromptFile: '/tmp/prompt.md',
      approvalMode: 'write',
    });

    expect(args[args.indexOf('--approval-mode') + 1]).toBe('write');
  });
});
