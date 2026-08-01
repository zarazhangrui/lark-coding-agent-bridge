import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import pkg from '../../../package.json';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { CodexAppServerJsonRpc } from './app-server-jsonrpc';
import {
  buildLeanAppServerArgs,
  parseCodexFeatureList,
  type CodexAppServerConfigInventory,
} from './app-server-lean';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerProcessOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  larkChannel?: LarkChannelEnvContext;
}

export interface AppServerConfigProbeInput {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  featureListTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export interface TerminateChildOptions {
  eofGraceMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
}

const RPC_TIMEOUT_MS = 15_000;
const FEATURE_LIST_TIMEOUT_MS = 5_000;
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_FEATURE_LIST_CHARS = 1024 * 1024;

/** POSIX children get their own process group so wrapper descendants can be terminated together. */
export const APP_SERVER_PROCESS_GROUP_ENABLED = process.platform !== 'win32';

export async function readAppServerConfigInventory(
  input: AppServerConfigProbeInput,
): Promise<CodexAppServerConfigInventory> {
  const features = await readAppServerFeatureInventory(input);
  const child = spawnProcess(input.binary, buildLeanAppServerArgs({ features }), {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: APP_SERVER_PROCESS_GROUP_ENABLED,
  }) as CodexAppServerChild;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let writeTail = Promise.resolve();
  const writeMessage = (message: unknown): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    const operation = writeTail.then(
      () => new Promise<void>((resolve, reject) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          reject(new Error('codex app-server config probe stdin is closed'));
          return;
        }
        child.stdin.write(line, 'utf8', (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    );
    writeTail = operation.catch(() => undefined);
    return operation;
  };
  const rpc = new CodexAppServerJsonRpc(writeMessage);
  const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      rpc.fail(new Error(
        stderr.slice(0, 500) || `codex app-server config probe exited: ${code ?? signal ?? 'unknown'}`,
      ));
      readline.close();
      resolve();
    });
  });
  child.once('error', (err) => rpc.fail(err));
  child.stdin.on('error', (err) => rpc.fail(err));
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 16 * 1024) return;
    stderrChunks.push(chunk);
    stderrBytes += chunk.byteLength;
  });
  readline.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_PROTOCOL_LINE_CHARS) {
      rpc.fail(new Error('codex app-server config probe emitted an oversized protocol line'));
      return;
    }
    try {
      const incoming = rpc.receive(JSON.parse(trimmed));
      if (incoming?.kind === 'request') {
        void rpc.respondError(incoming.id, -32601, `unsupported config probe request: ${incoming.method}`);
      }
    } catch (err) {
      rpc.fail(err);
    }
  });

  try {
    if (!child.pid) throw new Error('failed to spawn codex app-server config probe');
    await withTimeout(
      rpc.request('initialize', {
        clientInfo: {
          name: 'lark-channel-bridge-config-probe',
          title: 'Lark Channel Bridge Config Probe',
          version: pkg.version,
        },
        capabilities: null,
      }),
      RPC_TIMEOUT_MS,
      'config probe initialize',
    );
    await rpc.notify('initialized');
    const response = recordValue(await withTimeout(
      rpc.request('config/read', { includeLayers: false, cwd: input.cwd }),
      RPC_TIMEOUT_MS,
      'config/read',
    ));
    const config = recordValue(response?.config);
    if (!config) throw new Error('codex app-server config/read returned no config');
    return { features, mcp_servers: config.mcp_servers ?? config.mcpServers };
  } finally {
    const graceMs = input.shutdownGraceMs ?? 500;
    await terminateAndReapChild(child, closed, {
      eofGraceMs: graceMs,
      terminateGraceMs: graceMs,
      killGraceMs: graceMs,
    });
  }
}

export async function readAppServerFeatureInventory(
  input: AppServerConfigProbeInput,
): Promise<string[]> {
  const child = spawnProcess(input.binary, ['features', 'list'], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: APP_SERVER_PROCESS_GROUP_ENABLED,
  });
  let stdout = '';
  let stderr = '';
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_FEATURE_LIST_CHARS) stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
  });

  const timeoutMs = input.featureListTimeoutMs ?? FEATURE_LIST_TIMEOUT_MS;
  try {
    const { code, signal } = await withTimeout(result, timeoutMs, 'codex features list');
    if (code !== 0) {
      throw new Error(
        stderr.trim().slice(0, 500)
          || `codex features list exited: ${code ?? signal ?? 'unknown'}`,
      );
    }
    const features = parseCodexFeatureList(stdout);
    if (features.length === 0) {
      throw new Error('codex features list returned no parseable feature inventory');
    }
    return features;
  } finally {
    const graceMs = input.shutdownGraceMs ?? 500;
    await terminateAndReapChild(child, closed, {
      eofGraceMs: 0,
      terminateGraceMs: graceMs,
      killGraceMs: graceMs,
    });
  }
}

export async function terminateAndReapChild(
  child: ChildProcess,
  closed: Promise<unknown>,
  options: TerminateChildOptions = {},
): Promise<boolean> {
  const eofGraceMs = options.eofGraceMs ?? 500;
  const terminateGraceMs = options.terminateGraceMs ?? 500;
  const killGraceMs = options.killGraceMs ?? 500;
  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  if (await waitForPromise(closed, eofGraceMs)) {
    return terminateAppServerProcessGroup(child, { terminateGraceMs, killGraceMs });
  }

  signalAppServerProcess(child, 'SIGTERM');
  if (await waitForPromise(closed, terminateGraceMs)) {
    return terminateAppServerProcessGroup(child, {
      terminateGraceMs: 0,
      killGraceMs,
    });
  }

  signalAppServerProcess(child, 'SIGKILL');
  const childReaped = await waitForPromise(closed, killGraceMs);
  if (!childReaped) {
    log.warn('app-server', 'child-reap-timeout', {
      pid: child.pid ?? null,
      killGraceMs,
    });
  }
  const groupReaped = await terminateAppServerProcessGroup(child, {
    terminateGraceMs: 0,
    killGraceMs,
  });
  return childReaped && groupReaped;
}

export function signalAppServerProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const pid = child.pid;
  if (APP_SERVER_PROCESS_GROUP_ENABLED && pid && signalProcessGroup(pid, signal)) return true;

  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch (err) {
    log.warn('app-server', 'child-signal-failed', {
      pid: pid ?? null,
      signal,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    return false;
  }
}

export async function terminateAppServerProcessGroup(
  child: ChildProcess,
  options: Pick<TerminateChildOptions, 'terminateGraceMs' | 'killGraceMs'> = {},
): Promise<boolean> {
  if (!APP_SERVER_PROCESS_GROUP_ENABLED || !child.pid) return true;
  const pid = child.pid;
  if (!isProcessGroupAlive(pid)) return true;

  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, options.terminateGraceMs ?? 500)) return true;

  signalProcessGroup(pid, 'SIGKILL');
  const reaped = await waitForProcessGroupExit(pid, options.killGraceMs ?? 500);
  if (!reaped) {
    log.warn('app-server', 'process-group-reap-timeout', {
      pid,
      killGraceMs: options.killGraceMs ?? 500,
    });
  }
  return reaped;
}

export function buildAppServerProcessEnv(options: CodexAppServerProcessOptions): NodeJS.ProcessEnv {
  const envOverrides = buildLarkChannelEnv(options.larkChannel);
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return mergeProcessEnv(process.env, envOverrides);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      log.warn('app-server', 'process-group-signal-failed', {
        pid,
        signal,
        code: code ?? null,
      });
    }
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isProcessGroupAlive(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remainingMs)));
  }
  return true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
