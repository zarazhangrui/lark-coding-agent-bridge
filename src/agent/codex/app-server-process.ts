import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';

export type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerProcessOptions {
  binary: string;
  /** A complete environment snapshot. Undefined means the bridge process env. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  profileStateDir?: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  larkChannel?: LarkChannelEnvContext;
  /** Dependency injection for process-level tests. */
  spawn?: CodexAppServerSpawn;
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type CodexAppServerSignal = (pid: number, signal: NodeJS.Signals) => void;

/** POSIX children get their own process group so descendants can be cleaned up. */
export const APP_SERVER_PROCESS_GROUP_ENABLED = process.platform !== 'win32';

/**
 * Construct the app-server environment without changing the user's Codex
 * configuration. In particular, no CODEX_HOME/config.toml flags or MCP/plugin
 * overrides are injected here.
 */
export function buildAppServerProcessEnv(options: CodexAppServerProcessOptions): NodeJS.ProcessEnv {
  const base = options.env ?? process.env;
  const overrides = buildLarkChannelEnv(options.larkChannel);
  if (options.codexHome) {
    overrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false && options.profileStateDir) {
    overrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return mergeProcessEnv(base, overrides);
}

export function spawnCodexAppServer(options: CodexAppServerProcessOptions): CodexAppServerChild {
  const spawn = options.spawn ?? spawnProcess;
  const child = spawn(options.binary, [
    'app-server',
    '--listen',
    'stdio://',
    // The bridge injects LARK_* binding variables into the app-server
    // environment. Preserve them for shell/MCP children just as the legacy
    // `codex exec` transport did.
    '-c',
    'shell_environment_policy.inherit="all"',
  ], {
    cwd: options.cwd,
    env: buildAppServerProcessEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: APP_SERVER_PROCESS_GROUP_ENABLED,
  });
  return child as CodexAppServerChild;
}

export interface TerminateAppServerOptions {
  eofGraceMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  /** Dependency injection for deterministic process-group cleanup tests. */
  signalProcess?: CodexAppServerSignal;
}

/** Close stdin, then terminate and finally kill an app-server child. */
export async function terminateAndReapAppServer(
  child: ChildProcess,
  closed: Promise<unknown>,
  options: TerminateAppServerOptions = {},
): Promise<boolean> {
  const eofGraceMs = options.eofGraceMs ?? 500;
  const terminateGraceMs = options.terminateGraceMs ?? 500;
  const killGraceMs = options.killGraceMs ?? 500;
  const signalProcess = options.signalProcess;
  const groupCleanup = APP_SERVER_PROCESS_GROUP_ENABLED
    && typeof child.pid === 'number'
    && child.pid > 0;

  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  if (await waitFor(closed, eofGraceMs) && !groupCleanup) return true;

  // A resolved `closed` promise only proves the leader exited. On POSIX the
  // detached process group may still contain MCP/background descendants, so
  // continue signalling the group even after the leader is gone.
  const terminated = signalAppServerProcess(child, 'SIGTERM', signalProcess);
  if (groupCleanup) {
    if (!terminated) return true;
    await delay(terminateGraceMs);
    signalAppServerProcess(child, 'SIGKILL', signalProcess);
    await delay(killGraceMs);
    return true;
  }
  if (await waitFor(closed, terminateGraceMs)) return true;

  signalAppServerProcess(child, 'SIGKILL', signalProcess);
  return waitFor(closed, killGraceMs);
}

export function signalAppServerProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  signalProcess: CodexAppServerSignal = (pid, value) => process.kill(pid, value),
): boolean {
  const leaderExited = child.exitCode !== null || child.signalCode !== null;
  const pid = child.pid;
  if (APP_SERVER_PROCESS_GROUP_ENABLED && typeof pid === 'number' && pid > 0) {
    try {
      signalProcess(-pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The process group has already disappeared; do not signal an unrelated
      // child with a fallback kill in this case.
      if (code === 'ESRCH') return false;
      // Permission/unsupported group signalling falls back to the direct
      // child, which is still safer than leaving the app-server alive.
    }
  }
  // On POSIX a leader may have exited while a process-group signal failed for
  // a reason other than ESRCH (for example EPERM). Still attempt the direct
  // child fallback as required by the caller's injected signal policy. On
  // Windows (or without a valid group pid), an already-exited leader is done.
  if (leaderExited && !(APP_SERVER_PROCESS_GROUP_ENABLED && typeof pid === 'number' && pid > 0)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}
