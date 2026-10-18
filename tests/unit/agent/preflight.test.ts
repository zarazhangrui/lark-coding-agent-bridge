import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPreflightError,
  checkAgentVersion,
  formatAgentPreflightError,
  isAgentPreflightDiagnostic,
} from '../../../src/agent/preflight.js';

describe('agent preflight diagnostics', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/platform/spawn');
    vi.resetModules();
  });

  it('classifies version checks killed by a signal without exposing code null', async () => {
    vi.resetModules();
    vi.doMock('../../../src/platform/spawn', () => ({
      spawnProcess: vi.fn(() => fakeSignaledChild()),
    }));
    const { checkAgentVersion } = await import('../../../src/agent/preflight.js');

    await expect(
      checkAgentVersion({
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: 'codex',
        binaryPath: '/virtual/codex',
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-signaled',
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: 'codex',
        binaryPath: '/virtual/codex',
        args: ['--version'],
        exitCode: null,
        signal: 'SIGTERM',
      },
    });
  });

  it('renders a concise user-facing message for signaled version checks', () => {
    const err = new AgentPreflightError({
      code: 'agent-version-check-signaled',
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: 'codex',
      binaryPath: '/opt/homebrew/bin/codex',
      args: ['--version'],
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(formatAgentPreflightError(err)).toBe(
      [
        '✗ 本地 Codex CLI 不可用：执行 `codex --version` 时被系统终止（SIGKILL）。',
        '',
        '请先在终端确认：',
        '  codex --version',
        '',
        '修复本地 Codex CLI 后，再重新运行 bridge。',
        '错误码：agent-version-check-signaled',
      ].join('\n'),
    );
    expect(formatAgentPreflightError(err)).not.toContain('code null');
  });

  it('classifies non-zero, empty, and missing version checks', async () => {
    const missing = join(tmpdir(), `missing-agent-${Date.now()}`);

    await expect(
      checkAgentVersion({
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: 'codex',
        binaryPath: process.execPath,
        args: ['-e', 'process.stderr.write("boom\\n"); process.exit(42);'],
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-nonzero-exit',
        exitCode: 42,
        stderrExcerpt: 'boom',
      },
    });

    await expect(
      checkAgentVersion({
        agentId: 'claude',
        agentName: 'Claude Code',
        command: 'claude',
        binaryPath: process.execPath,
        args: ['-e', 'process.exit(0);'],
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-empty-output',
        agentId: 'claude',
      },
    });

    await expect(
      checkAgentVersion({
        agentId: 'claude',
        agentName: 'Claude Code',
        command: 'claude',
        binaryPath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        errno: 'ENOENT',
      },
    });
  });

  it('renders concise messages for each diagnostic category', () => {
    const cases = [
      ['agent-binary-not-found', '✗ 未找到本地 Codex CLI。'],
      ['agent-binary-not-executable', '✗ 本地 Codex CLI 不可执行。'],
      ['agent-binary-resolve-failed', '✗ 本地 Codex CLI 路径解析失败。'],
      ['agent-binary-not-readable', '✗ 本地 Codex CLI 二进制不可读取。'],
      ['agent-version-check-spawn-failed', '✗ 本地 Codex CLI 不可用：无法执行 `codex --version`。'],
      ['agent-version-check-timeout', '✗ 本地 Codex CLI 不可用：`codex --version` 超时未返回。'],
      ['agent-version-check-nonzero-exit', '✗ 本地 Codex CLI 不可用：`codex --version` 退出码为 42。'],
      ['agent-version-check-empty-output', '✗ 本地 Codex CLI 不可用：`codex --version` 没有返回版本信息。'],
    ] as const;

    for (const [code, firstLine] of cases) {
      const err = new AgentPreflightError({
        code,
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: 'codex',
        binaryPath: '/opt/homebrew/bin/codex',
        args: ['--version'],
        exitCode: 42,
        signal: 'SIGKILL',
      });
      const message = formatAgentPreflightError(err);

      expect(message.split('\n')[0]).toBe(firstLine);
      expect(message).toContain(`错误码：${code}`);
      expect(message).not.toContain('/opt/homebrew');
    }
  });

  it('accepts kimi as a diagnostic agentId alongside claude and codex', () => {
    for (const agentId of ['claude', 'codex', 'kimi'] as const) {
      expect(
        isAgentPreflightDiagnostic({
          code: 'agent-binary-not-found',
          agentId,
          agentName: 'Kimi Code',
          command: agentId,
        }),
      ).toBe(true);
    }
    expect(
      isAgentPreflightDiagnostic({
        code: 'agent-binary-not-found',
        agentId: 'other',
        agentName: 'Other',
        command: 'other',
      }),
    ).toBe(false);
  });
});

function fakeSignaledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  return child;
}
