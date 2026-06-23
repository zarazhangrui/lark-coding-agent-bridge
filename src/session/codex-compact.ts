import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CompactCodexThreadOptions {
  binary: string;
  threadId: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
}

export type CodexCompactErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexCompactError extends Error {
  readonly code: CodexCompactErrorCode;

  constructor(code: CodexCompactErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexCompactError';
    this.code = code;
  }
}

const DEFAULT_COMPACT_TIMEOUT_MS = 3 * 60 * 1000;

export async function compactCodexThread(options: CompactCodexThreadOptions): Promise<void> {
  const child = spawnCodexAppServer(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
  const stderrChunks: Buffer[] = [];
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestAccepted = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      reject(
        err instanceof CodexCompactError
          ? err
          : new CodexCompactError('spawn-failed', errorMessage(err)),
      );
      cleanup({ kill: true });
    };

    const cleanup = (opts: { kill: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener('error', fail);
      child.stdin.removeListener('error', fail);
      child.stderr.removeAllListeners('data');
      if (opts.kill && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    timer = setTimeout(() => {
      reject(new CodexCompactError('timeout', `codex compact timed out after ${timeoutMs}ms`));
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
      if (!response) return;
      if (response.id === 2) {
        if (response.error) {
          reject(new CodexCompactError('app-server-error', appServerErrorMessage(response.error)));
          cleanup({ kill: true });
          return;
        }
        requestAccepted = true;
        return;
      }
      if (response.method === 'thread/compacted') {
        const params = recordValue(response.params);
        if (stringValue(params?.threadId) !== options.threadId) return;
        resolve();
        cleanup({ kill: true });
        return;
      }
      if (response.method === 'error') {
        const params = recordValue(response.params);
        if (stringValue(params?.threadId) !== options.threadId) return;
        reject(new CodexCompactError('app-server-error', appServerErrorMessage(params?.error ?? params)));
        cleanup({ kill: true });
      }
    });

    child.once('exit', (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(
        new CodexCompactError(
          requestAccepted ? 'malformed-response' : 'spawn-failed',
          `codex app-server exited before compact completed: ${code ?? 'signal'}${stderr ? `: ${stderr}` : ''}`,
        ),
      );
      cleanup({ kill: true });
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n${JSON.stringify(compactRequest(options.threadId))}\n`,
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
}

function spawnCodexAppServer(options: CompactCodexThreadOptions): CodexAppServerChild {
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

function compactRequest(threadId: string) {
  return {
    method: 'thread/compact/start',
    id: 2,
    params: { threadId },
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

function appServerErrorMessage(input: unknown): string {
  const raw = recordValue(input);
  const message = stringValue(raw?.message) ?? stringValue(raw?.error);
  if (message) return message;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
