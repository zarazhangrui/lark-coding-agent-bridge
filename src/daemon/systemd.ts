import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  systemdUnitName,
  systemdUnitPath,
} from './paths';
import { paths } from '../config/paths';
import { collectProxyEnv, type EnvVar } from './proxy-env';

export interface UnitInputs {
  /** Absolute path to the node binary that should run the bridge. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry (the file currently executing). */
  bridgeEntryPath: string;
  /** PATH for the daemon process — captured from current shell so child
   * tools (lark-cli, claude) can be resolved by name. systemd user units
   * inherit a minimal env otherwise. */
  envPath: string;
  /** Profile this service instance is pinned to. */
  profile: string;
  /** Root directory for config/profile state. */
  channelHome: string;
  /** Proxy vars captured from the install-time shell. systemd user units
   * ignore the shell rc, so without these the daemon (and the agent it
   * spawns) runs with no proxy. Empty when the host has none configured. */
  proxyEnv?: EnvVar[];
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
  // systemd treats `%` as a specifier-expansion sigil in unit-file values, so a
  // literal `%` (common in percent-encoded proxy credentials, e.g. `p%40ss`)
  // must be doubled or systemd rewrites/rejects it.
  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  const proxyLines = (inputs.proxyEnv ?? [])
    .map((e) => `Environment="${escape(e.key)}=${escape(e.value)}"`)
    .join('\n');
  return `[Unit]
Description=Lark Channel Bridge bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escape(inputs.nodePath)}" "${escape(inputs.bridgeEntryPath)}" run --profile "${escape(inputs.profile)}"
Restart=always
RestartSec=5
StandardOutput=append:${daemonStdoutPath(inputs.profile)}
StandardError=append:${daemonStderrPath(inputs.profile)}
Environment="PATH=${escape(inputs.envPath)}"
Environment="LARK_CHANNEL_HOME=${escape(inputs.channelHome)}"${proxyLines ? '\n' + proxyLines : ''}

[Install]
WantedBy=default.target
`;
}

export async function writeUnit(profile: string): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildUnit({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    channelHome: paths.rootDir,
    proxyEnv: collectProxyEnv(),
  });
  const unitPath = systemdUnitPath(profile);
  await mkdir(dirname(unitPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  // 0600: the unit may embed proxy URLs carrying credentials (user:pass@host).
  await writeFile(unitPath, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(unitPath, 0o600);
}

export function unitExists(profile: string): boolean {
  return existsSync(systemdUnitPath(profile));
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
export function enableAndStart(profile: string): SystemctlResult {
  return runSystemctl(['enable', '--now', systemdUnitName(profile)]);
}

/** Stop now (service stays enabled — will auto-start on next boot). */
export function stop(profile: string): SystemctlResult {
  return runSystemctl(['stop', systemdUnitName(profile)]);
}

/** Disable autostart + stop now. Used by `unregister` flow. */
export function disableAndStop(profile: string): SystemctlResult {
  return runSystemctl(['disable', '--now', systemdUnitName(profile)]);
}

/** Bounce the service in place. */
export function restart(profile: string): SystemctlResult {
  return runSystemctl(['restart', systemdUnitName(profile)]);
}

/**
 * `is-active` returns 0 iff service state is "active". inactive/failed
 * both yield non-zero (and the failure reason lands in stdout, not stderr).
 */
export function isActive(profile: string): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-active', systemdUnitName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/** Raw `systemctl status` output, parsed downstream for pid / exit code. */
export function describeService(profile: string): string {
  const r = runSystemctl(['status', systemdUnitName(profile), '--no-pager']);
  return r.stdout || r.stderr || '';
}

/** systemctl stop is synchronous (waits for exit) but we keep parity with
 * launchd's waitUntilUnloaded so service.ts can call it uniformly. */
export async function waitUntilInactive(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteUnit(profile: string): Promise<void> {
  await rm(systemdUnitPath(profile), { force: true });
}
