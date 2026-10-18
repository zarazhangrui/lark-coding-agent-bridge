import { spawnProcess } from '../platform/spawn';

export type LocalAgentId = 'claude' | 'codex' | 'pi';

export type AgentPreflightErrorCode =
  | 'agent-binary-not-found'
  | 'agent-binary-not-executable'
  | 'agent-binary-resolve-failed'
  | 'agent-binary-not-readable'
  | 'agent-version-check-spawn-failed'
  | 'agent-version-check-timeout'
  | 'agent-version-check-signaled'
  | 'agent-version-check-nonzero-exit'
  | 'agent-version-check-empty-output';

export interface AgentPreflightDiagnostic {
  code: AgentPreflightErrorCode;
  agentId: LocalAgentId;
  agentName: string;
  command: string;
  binaryPath?: string;
  realpath?: string;
  args?: readonly string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timeoutMs?: number;
  errno?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  field?: string;
  expected?: string | number;
  actual?: string | number;
}

export type AgentAvailability =
  | { ok: true; version?: string }
  | { ok: false; error: AgentPreflightError; diagnostic: AgentPreflightDiagnostic };

export interface CheckAgentVersionInput {
  agentId: LocalAgentId;
  agentName: string;
  command: string;
  binaryPath: string;
  realpath?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

export class AgentPreflightError extends Error {
  readonly diagnostic: AgentPreflightDiagnostic;

  constructor(diagnostic: AgentPreflightDiagnostic, message?: string) {
    super(message ?? summaryForDiagnostic(diagnostic));
    this.name = 'AgentPreflightError';
    this.diagnostic = diagnostic;
  }
}

export async function checkAgentAvailability(
  input: CheckAgentVersionInput,
): Promise<AgentAvailability> {
  try {
    return { ok: true, version: await checkAgentVersion(input) };
  } catch (err) {
    if (err instanceof AgentPreflightError) {
      return { ok: false, error: err, diagnostic: err.diagnostic };
    }
    throw err;
  }
}

export async function checkAgentVersion(input: CheckAgentVersionInput): Promise<string> {
  const args = input.args ?? ['--version'];
  const timeoutMs = input.timeoutMs ?? 5000;
  const executable = input.realpath ?? input.binaryPath;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const base = (): Omit<AgentPreflightDiagnostic, 'code'> => ({
      agentId: input.agentId,
      agentName: input.agentName,
      command: input.command,
      binaryPath: input.binaryPath,
      ...(input.realpath ? { realpath: input.realpath } : {}),
      args,
      stdoutExcerpt: excerpt(stdout),
      stderrExcerpt: excerpt(stderr),
    });

    const child = (() => {
      try {
        return spawnProcess(executable, [...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish(() =>
          reject(
            new AgentPreflightError({
              ...base(),
              code: codeForSpawnError(err as NodeJS.ErrnoException),
              errno: (err as NodeJS.ErrnoException).code,
            }),
          ),
        );
        return undefined;
      }
    })();
    if (!child) return;

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() =>
        reject(
          new AgentPreflightError({
            ...base(),
            code: 'agent-version-check-timeout',
            timeoutMs,
          }),
        ),
      );
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new AgentPreflightError({
            ...base(),
            code: codeForSpawnError(err),
            errno: err.code,
          }),
        ),
      );
    });
    child.once('exit', (exitCode, signal) => {
      finish(() => {
        if (signal) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: 'agent-version-check-signaled',
              exitCode,
              signal,
            }),
          );
          return;
        }
        if (exitCode !== 0) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: 'agent-version-check-nonzero-exit',
              exitCode,
              signal,
            }),
          );
          return;
        }
        const version = (stdout.trim() || stderr.trim()).split('\n')[0]?.trim();
        if (!version) {
          reject(
            new AgentPreflightError({
              ...base(),
              code: 'agent-version-check-empty-output',
              exitCode,
              signal,
            }),
          );
          return;
        }
        resolve(version);
      });
    });
  });
}

export function formatAgentPreflightError(err: AgentPreflightError): string {
  return formatAgentPreflightDiagnostic(err.diagnostic);
}

export function formatAgentPreflightDiagnostic(diagnostic: AgentPreflightDiagnostic): string {
  const command = commandForDisplay(diagnostic);
  switch (diagnostic.code) {
    case 'agent-binary-not-found':
      return [
        `✗ 未找到本地 ${diagnostic.agentName}。`,
        '',
        `请先安装 ${diagnostic.agentName}，或配置正确的可执行文件路径。`,
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-binary-not-executable':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可执行。`,
        '',
        `请检查可执行权限，或重新安装 ${diagnostic.agentName}。`,
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-binary-resolve-failed':
      return [
        `✗ 本地 ${diagnostic.agentName} 路径解析失败。`,
        '',
        '请确认当前配置的可执行文件路径有效后，再重新运行 bridge。',
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-binary-not-readable':
      return [
        `✗ 本地 ${diagnostic.agentName} 二进制不可读取。`,
        '',
        `请检查文件权限，或重新安装 ${diagnostic.agentName}。`,
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-version-check-spawn-failed':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可用：无法执行 \`${command}\`。`,
        '',
        '请先在终端运行同一命令并修复报错。',
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-version-check-timeout':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可用：\`${command}\` 超时未返回。`,
        '',
        '请先确认该命令能正常结束。',
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-version-check-signaled':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可用：执行 \`${command}\` 时被系统终止（${diagnostic.signal ?? 'unknown'}）。`,
        '',
        '请先在终端确认：',
        `  ${command}`,
        '',
        `修复本地 ${diagnostic.agentName} 后，再重新运行 bridge。`,
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-version-check-nonzero-exit':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可用：\`${command}\` 退出码为 ${diagnostic.exitCode ?? 'unknown'}。`,
        '',
        '请先在终端运行同一命令并修复报错。',
        `错误码：${diagnostic.code}`,
      ].join('\n');
    case 'agent-version-check-empty-output':
      return [
        `✗ 本地 ${diagnostic.agentName} 不可用：\`${command}\` 没有返回版本信息。`,
        '',
        `请确认安装的是受支持的 ${diagnostic.agentName}。`,
        `错误码：${diagnostic.code}`,
      ].join('\n');
  }
}

export function getAgentPreflightDiagnostic(err: unknown): AgentPreflightDiagnostic | undefined {
  if (err instanceof AgentPreflightError) return err.diagnostic;
  if (!err || typeof err !== 'object') return undefined;
  const diagnostic = (err as { diagnostic?: unknown }).diagnostic;
  if (isAgentPreflightDiagnostic(diagnostic)) return diagnostic;
  return getAgentPreflightDiagnostic((err as { cause?: unknown }).cause);
}

export function isAgentPreflightDiagnostic(input: unknown): input is AgentPreflightDiagnostic {
  if (!input || typeof input !== 'object') return false;
  const raw = input as { code?: unknown; agentId?: unknown; agentName?: unknown; command?: unknown };
  return (
    typeof raw.code === 'string' &&
    raw.code.startsWith('agent-') &&
    (raw.agentId === 'claude' || raw.agentId === 'codex' || raw.agentId === 'pi') &&
    typeof raw.agentName === 'string' &&
    typeof raw.command === 'string'
  );
}

function codeForSpawnError(err: NodeJS.ErrnoException): AgentPreflightErrorCode {
  if (err.code === 'ENOENT') return 'agent-binary-not-found';
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'agent-binary-not-executable';
  return 'agent-version-check-spawn-failed';
}

function commandForDisplay(diagnostic: AgentPreflightDiagnostic): string {
  return [diagnostic.command, ...(diagnostic.args ?? [])].join(' ');
}

function summaryForDiagnostic(diagnostic: AgentPreflightDiagnostic): string {
  return `${diagnostic.agentName} preflight failed: ${diagnostic.code}`;
}

function excerpt(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}
