import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SYSTEMD_UNIT_NAME,
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  systemdUnitPath,
} from './paths';

export interface UnitInputs {
  /** Absolute path to the node binary that should run the bridge. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry (the file currently executing). */
  bridgeEntryPath: string;
  /** PATH for the daemon process — captured from current shell so child
   * tools (lark-cli, claude) can be resolved by name. systemd user units
   * inherit a minimal env otherwise. */
  envPath: string;
  runArgs?: string[];
}

/**
 * `Restart=always` + `RestartSec=5` matches launchd's KeepAlive=true
 * behaviour with a 5s back-off so a crash-loop doesn't pin the CPU.
 *
 * `Type=simple` is the right fit: systemd treats the service as started
 * the moment ExecStart fires (bridge's WS handshake happens later, just
 * as on macOS). Our CLI polls the registry for the connection separately.
 *
 * `WantedBy=default.target` makes `systemctl --user enable` auto-start
 * the service when the user logs in. Note: systemd user services only
 * survive logout if `loginctl enable-linger <user>` is set — we mention
 * this in the user-facing success message.
 */
export function buildUnit(inputs: UnitInputs): string {
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[Unit]
Description=Lark Channel Bridge bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escape(inputs.nodePath)}" "${escape(inputs.bridgeEntryPath)}" ${(inputs.runArgs ?? ['run']).map((arg) => `"${escape(arg)}"`).join(' ')}
Restart=always
RestartSec=5
StandardOutput=append:${daemonStdoutPath()}
StandardError=append:${daemonStderrPath()}
Environment="PATH=${escape(inputs.envPath)}"

[Install]
WantedBy=default.target
`;
}

export async function writeUnit(runArgs?: string[]): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildUnit({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    runArgs,
  });
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(unitPath, content, 'utf8');
}

export function unitExists(): boolean {
  return existsSync(systemdUnitPath());
}

interface SystemctlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSystemctl(args: string[]): SystemctlResult {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

/** Tell systemd to re-scan unit files after we write/remove one. */
export function daemonReload(): SystemctlResult {
  return runSystemctl(['daemon-reload']);
}

/** Enable autostart on login + start now. Equivalent to launchd bootstrap. */
export function enableAndStart(): SystemctlResult {
  return runSystemctl(['enable', '--now', SYSTEMD_UNIT_NAME]);
}

/** Stop now (service stays enabled — will auto-start on next boot). */
export function stop(): SystemctlResult {
  return runSystemctl(['stop', SYSTEMD_UNIT_NAME]);
}

/** Disable autostart + stop now. Used by `unregister` flow. */
export function disableAndStop(): SystemctlResult {
  return runSystemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
}

/** Bounce the service in place. */
export function restart(): SystemctlResult {
  return runSystemctl(['restart', SYSTEMD_UNIT_NAME]);
}

/**
 * `is-active` returns 0 iff service state is "active". inactive/failed
 * both yield non-zero (and the failure reason lands in stdout, not stderr).
 */
export function isActive(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/** Raw `systemctl status` output, parsed downstream for pid / exit code. */
export function describeService(): string {
  const r = runSystemctl(['status', SYSTEMD_UNIT_NAME, '--no-pager']);
  return r.stdout || r.stderr || '';
}

/** systemctl stop is synchronous (waits for exit) but we keep parity with
 * launchd's waitUntilUnloaded so service.ts can call it uniformly. */
export async function waitUntilInactive(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteUnit(): Promise<void> {
  await rm(systemdUnitPath(), { force: true });
}
