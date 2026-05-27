import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  WINDOWS_TASK_NAME,
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsLauncherCmdPath,
} from './paths';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  runArgs?: string[];
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
  return [
    '@echo off',
    `set "PATH=${inputs.envPath}"`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" ${(inputs.runArgs ?? ['run']).map((arg) => `"${arg.replace(/"/g, '""')}"`).join(' ')} >> "${daemonStdoutPath()}" 2>> "${daemonStderrPath()}"`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(runArgs?: string[]): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    runArgs,
  });
  const cmdPath = windowsLauncherCmdPath();
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
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
export async function installTask(runArgs?: string[]): Promise<SchtasksResult> {
  await writeLauncherCmd(runArgs);
  return runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    `"${windowsLauncherCmdPath()}"`,
  ]);
}

/** Start the task now (regardless of trigger). */
export function runTask(): SchtasksResult {
  return runSchtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(): SchtasksResult {
  return runSchtasks(['/End', '/TN', WINDOWS_TASK_NAME]);
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(): SchtasksResult {
  return runSchtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(): SchtasksResult {
  return runSchtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(): SchtasksResult {
  const ended = endTask();
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask();
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(): Promise<SchtasksResult> {
  endTask(); // best-effort; ignore if not running
  await waitUntilStopped();
  return runTask();
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Parse `/Query /V /FO LIST` output for the current run state. Looks for
 * `Status: Running` in the verbose listing. Other states include
 * "Ready" (registered, not currently running) and "Disabled".
 */
export function isTaskRunning(): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', WINDOWS_TASK_NAME]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', WINDOWS_TASK_NAME]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
  // Remove the launcher script too; best-effort.
  if (existsSync(windowsLauncherCmdPath())) {
    await rm(windowsLauncherCmdPath(), { force: true });
  }
  return r;
}
