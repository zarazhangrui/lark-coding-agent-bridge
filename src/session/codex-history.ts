import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';
import { t } from '../i18n';
import { normalizeSessionPreview } from './preview';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown';

export interface CodexThreadHistoryEntry {
  threadId: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: string;
  name?: string;
}

export interface ListCodexThreadHistoryOptions {
  binary: string;
  cwd: string;
  limit: number;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
  sourceKinds?: readonly CodexThreadSourceKind[];
  useStateDbOnly?: boolean;
}

export type CodexHistoryErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode;

  constructor(code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexHistoryError';
    this.code = code;
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_SOURCE_KINDS: readonly CodexThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
];

export async function listCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
): Promise<CodexThreadHistoryEntry[]> {
  const child = spawnCodexAppServer(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const stderrChunks: Buffer[] = [];
  let settled = false;

  const result = await new Promise<CodexThreadHistoryEntry[]>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (err: unknown): void => {
      if (settled) return;
      reject(
        err instanceof CodexHistoryError
          ? err
          : new CodexHistoryError('spawn-failed', errorMessage(err)),
      );
      cleanup({ kill: true });
    };

    const cleanup = (options: { kill: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener('error', fail);
      child.stdin.removeListener('error', fail);
      child.stderr.removeAllListeners('data');
      if (options.kill && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    timer = setTimeout(() => {
      reject(new CodexHistoryError('timeout', `codex history query timed out after ${timeoutMs}ms`));
      cleanup({ kill: true });
    }, timeoutMs);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const response = recordValue(msg);
      if (!response || response.id !== 2) return;
      if (response.error) {
        const err = recordValue(response.error);
        reject(
          new CodexHistoryError(
            'app-server-error',
            typeof err?.message === 'string' ? err.message : 'codex app-server rejected history query',
          ),
        );
        cleanup({ kill: true });
        return;
      }
      const parsed = parseThreadListResponse(response.result);
      if (!parsed.ok) {
        reject(parsed.error);
        cleanup({ kill: true });
        return;
      }
      resolve(parsed.entries);
      cleanup({ kill: true });
    });

    child.once('exit', (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(
        new CodexHistoryError(
          'spawn-failed',
          `codex app-server exited before history response: ${code ?? 'signal'}${stderr ? `: ${stderr}` : ''}`,
        ),
      );
      cleanup({ kill: true });
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n${JSON.stringify(listRequest(options))}\n`,
        'utf8',
        (err?: Error | null) => {
          if (err) fail(err);
        },
      );
    } catch (err) {
      fail(err);
    }
  });

  await waitForChildExit(child, 250);
  return result;
}

function spawnCodexAppServer(options: ListCodexThreadHistoryOptions): CodexAppServerChild {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }

  return spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.2.3',
      },
      capabilities: null,
    },
  };
}

function listRequest(options: ListCodexThreadHistoryOptions) {
  return {
    method: 'thread/list',
    id: 2,
    params: {
      limit: options.limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      cwd: options.cwd,
      useStateDbOnly: options.useStateDbOnly ?? true,
      sourceKinds: [...(options.sourceKinds ?? DEFAULT_SOURCE_KINDS)],
    },
  };
}

function parseThreadListResponse(
  input: unknown,
): { ok: true; entries: CodexThreadHistoryEntry[] } | { ok: false; error: CodexHistoryError } {
  const raw = recordValue(input);
  if (!raw || !Array.isArray(raw.data)) {
    return {
      ok: false,
      error: new CodexHistoryError('malformed-response', 'codex app-server returned malformed thread/list response'),
    };
  }
  return {
    ok: true,
    entries: raw.data.map(normalizeThread).filter((entry): entry is CodexThreadHistoryEntry => Boolean(entry)),
  };
}

function normalizeThread(input: unknown): CodexThreadHistoryEntry | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const threadId = stringValue(raw.id);
  const cwd = stringValue(raw.cwd);
  if (!threadId || !cwd) return undefined;
  const createdAt = numberValue(raw.createdAt);
  const updatedAt = numberValue(raw.updatedAt);
  return {
    threadId,
    ...(stringValue(raw.sessionId) ? { sessionId: stringValue(raw.sessionId) } : {}),
    preview: normalizeSessionPreview(stringValue(raw.preview) ?? '') || t('session.empty'),
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1000),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1000),
    source: sourceValue(raw.source),
    ...(stringValue(raw.name) ? { name: stringValue(raw.name) } : {}),
  };
}

async function waitForChildExit(child: CodexAppServerChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sourceValue(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return JSON.stringify(input);
  return 'unknown';
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
