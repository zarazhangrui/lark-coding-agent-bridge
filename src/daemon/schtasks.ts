import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
} from './paths';
import { paths } from '../config/paths';
import { collectProxyEnv, type EnvVar } from './proxy-env';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Profile this service instance is pinned to. */
  profile: string;
  /** Root directory for config/profile state. */
  channelHome: string;
  /** Proxy vars captured from the install-time shell. A scheduled task does
   * not inherit the shell rc, so without these the daemon (and the agent it
   * spawns) runs with no proxy. Empty when the host has none configured. */
  proxyEnv?: EnvVar[];
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
  // Inside `set "VAR=value"` a literal `%` is treated as a variable-expansion
  // sigil by cmd.exe (e.g. percent-encoded proxy credentials like `p%40ss`
  // would expand at runtime), so double it. Strip CR/LF defensively so a value
  // can't smuggle extra script lines into the wrapper.
  const escapeCmdValue = (s: string): string => s.replace(/%/g, '%%').replace(/[\r\n]/g, '');
  const proxyLines = (inputs.proxyEnv ?? []).map(
    (e) => `set "${escapeCmdValue(e.key)}=${escapeCmdValue(e.value)}"`,
  );
  return [
    '@echo off',
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    ...proxyLines,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" run --profile "${inputs.profile}" >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(profile: string): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    channelHome: paths.rootDir,
    proxyEnv: collectProxyEnv(),
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  // 0600: the wrapper may embed proxy URLs carrying credentials (user:pass@host).
  await writeFile(cmdPath, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(cmdPath, 0o600);
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
export async function installTask(profile: string): Promise<SchtasksResult> {
  await writeLauncherCmd(profile);
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

/** End the running instance. Task stays registered for next logon. */
export function endTask(profile: string): SchtasksResult {
  return runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
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
 */
export function isTaskRunning(profile: string): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
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
