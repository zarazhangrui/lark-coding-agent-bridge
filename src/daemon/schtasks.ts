import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
} from './paths';
import { paths } from '../config/paths';
import { resolveAppPaths } from '../config/app-paths';
import { readAndPrune, unregisterSync } from '../runtime/registry';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Service id (profile name, or the reserved supervisor id) — drives the
   * task name and log paths. */
  profile: string;
  /** CLI args after the entry path, e.g. `['run', '--profile', 'claude']` or
   * `['run', '--web-ui']`. */
  runArgs: string[];
  /** Root directory for config/profile state. */
  channelHome: string;
}

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, claude) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  // Profile names / flags are validated safe tokens (no spaces).
  const runArgs = inputs.runArgs.join(' ');
  return [
    '@echo off',
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" ${runArgs} >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(profile: string, runArgs: string[] = ['run']): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    runArgs,
    channelHome: paths.rootDir,
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

/**
 * Create (or overwrite) the scheduled task. Trigger: ONLOGON.
 * `/RL LIMITED` runs as the current user without admin elevation.
 * `/F` overwrites if the task already exists.
 *
 * The /TR value is the .cmd wrapper path. Schtasks treats /TR as a command
 * line, so wrapping in quotes keeps spaces in the path intact.
 */
export async function installTask(
  profile: string,
  runArgs: string[] = ['run'],
): Promise<SchtasksResult> {
  await writeLauncherCmd(profile, runArgs);
  return runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    windowsTaskName(profile),
    '/TR',
    `"${windowsLauncherCmdPath(profile)}"`,
  ]);
}

/** Start the task now (regardless of trigger). */
export function runTask(profile: string): SchtasksResult {
  return runSchtasks(['/Run', '/TN', windowsTaskName(profile)]);
}

/**
 * Terminate the process tree that the launcher .cmd spawned, if /End left
 * one behind, and clear its registry entry + lock files.
 *
 * Task Scheduler only terminates the process it started directly (the /TR
 * target); the node daemon that the launcher .cmd starts survives /End as
 * an orphan - it keeps the Feishu connection alive and holds the profile/app
 * locks, so `stop` doesn't actually stop the bot and the next `start` is
 * blocked by the stale locks. taskkill /T /F on the registry pid takes down
 * the whole tree; the proper-lockfile artifacts (`<name>.lock`,
 * `<name>.lock.meta.json` and the `<name>.lock.lock` mutex directory) are
 * removed so a subsequent `start` starts from clean state.
 *
 * Best-effort: any failure here must not mask the /End result. Callers only
 * reach endTask with a running task instance, so the registry entry belongs
 * to the task-launched daemon, not a foreground `run` process.
 */
function terminateLauncherTree(profile: string): void {
  try {
    const entry = readAndPrune().find(
      (e) => e.profileName === profile && typeof e.pid === 'number',
    );
    if (!entry) return;
    spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { stdio: 'ignore' });
    unregisterSync(entry.id);
    const appPaths = resolveAppPaths({ profile });
    for (const lockPath of [appPaths.profileLockFile, appPaths.appLockFile(entry.appId)]) {
      for (const suffix of ['', '.meta.json', '.lock']) {
        rmSync(`${lockPath}${suffix}`, { force: true, recursive: true });
      }
    }
  } catch {
    // best-effort; the /End result is what gets surfaced to the caller
  }
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(profile: string): SchtasksResult {
  const r = runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
  terminateLauncherTree(profile);
  return r;
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(profile: string): SchtasksResult {
  const ended = endTask(profile);
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask(profile);
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(profile: string): Promise<SchtasksResult> {
  endTask(profile); // best-effort; ignore if not running
  await waitUntilStopped(profile);
  return runTask(profile);
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(profile: string): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Parse `/Query /V /FO LIST` output for the current run state. Looks for
 * `Status: Running` in the verbose listing. Other states include
 * "Ready" (registered, not currently running) and "Disabled".
 *
 * Localized Windows (e.g. zh-CN) prints translated labels in the console
 * codepage, so `Status: Running` never matches - and since the output is
 * decoded as UTF-8, the translated text arrives as U+FFFD mojibake that
 * can't be matched either. The `Last Result` sentinel 267009
 * (0x41301, SCHED_S_TASK_RUNNING) is plain ASCII digits and works across
 * locales.
 */
export function isTaskRunning(profile: string): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout) || /267009/.test(r.stdout);
}

/**
 * Pid of the bot daemon this task launched, taken from the bridge's process
 * registry. Localized verbose listings have no `Process ID:` line at all, so
 * this is the locale-independent fallback for parseStatus.
 *
 * Only meaningful while the task is running: the registry also holds
 * entries for foreground `run` processes, which must not be reported as
 * service-managed pids.
 */
export function taskRuntimePid(profile: string): string | undefined {
  try {
    if (!isTaskRunning(profile)) return undefined;
    const entry = readAndPrune().find((e) => e.profileName === profile);
    return entry ? String(entry.pid) : undefined;
  } catch {
    return undefined;
  }
}

export function describeTask(profile: string): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(profile: string): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName(profile)]);
  // Remove the launcher script too; best-effort.
  if (existsSync(windowsLauncherCmdPath(profile))) {
    await rm(windowsLauncherCmdPath(profile), { force: true });
  }
  return r;
}
