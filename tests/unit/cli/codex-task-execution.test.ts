import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../../../src/codex-task/context', () => ({
  resolveCodexTaskContext: vi.fn(async () => ({
    controller: { send: mocks.send },
  })),
}));

import { runCodexTaskSend } from '../../../src/cli/commands/codex-task';

describe('codex-task execution CLI contract', () => {
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.send.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('prints timeout as incomplete and sets a non-zero exit code', async () => {
    mocks.send.mockResolvedValue(executionResult('timeout'));

    await runCodexTaskSend('T-A1B2C3', { message: 'long task' });

    expect(process.exitCode).toBe(1);
    const output = vi.mocked(console.log).mock.calls.flat().map(String).join('\n');
    expect(output).toContain('✗ T-A1B2C3 Worker');
    expect(output).not.toContain('✓ T-A1B2C3 Worker');
  });

  it('keeps durable and candidate thread ids out of JSON output', async () => {
    const result = executionResult('normal');
    Object.assign(result.task, {
      threadId: 'thread-durable',
      candidateThreadId: 'thread-private-candidate',
    });
    mocks.send.mockResolvedValue(result);

    await runCodexTaskSend('T-A1B2C3', { message: 'inspect output', json: true });

    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as {
      task: Record<string, unknown>;
    };
    expect(payload.task).not.toHaveProperty('threadId');
    expect(payload.task).not.toHaveProperty('candidateThreadId');
  });

  it('maps SIGINT to AbortSignal, cleans listeners, and preserves exit 130', async () => {
    const originalListeners = new Set(process.listeners('SIGINT'));
    mocks.send.mockImplementation(async (
      _handle: string,
      input: { signal?: AbortSignal },
    ) => {
      expect(input.signal).toBeDefined();
      const handler = process.listeners('SIGINT').find((listener) => !originalListeners.has(listener));
      expect(handler).toBeDefined();
      handler!('SIGINT');
      expect(input.signal?.aborted).toBe(true);
      return executionResult('interrupted');
    });

    await runCodexTaskSend('T-A1B2C3', { message: 'interrupt me' });

    expect(process.exitCode).toBe(130);
    expect(process.listeners('SIGINT')).toEqual([...originalListeners]);
  });
});

function executionResult(terminationReason: 'normal' | 'interrupted' | 'timeout') {
  return {
    task: {
      handle: 'T-A1B2C3',
      title: 'Worker',
      cwd: '/tmp/worker',
      status: terminationReason === 'normal' ? 'completed' : terminationReason,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:01.000Z',
    },
    output: '',
    terminationReason,
    registrySync: 'synced' as const,
  };
}
