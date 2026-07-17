import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAppPaths } from '../config/app-paths';
import { paths } from '../config/paths';

/**
 * Logical service name — used as the launchd label AND as the systemd
 * unit name. Single-instance for now; if we ever support multiple bots
 * per machine the suffix can grow `.{appid}` without breaking installs.
 */
export const SERVICE_NAME = 'lark-channel-bridge.bot';

/**
 * Reserved service id for the machine-wide supervisor+console daemon
 * (`start --web-ui`). Keyed distinctly from any real profile so the supervisor
 * service has a fixed label/log path (one per machine) and never flaps against
 * per-profile classic services. It passes `serviceProfileId` validation, so it
 * flows through the same label/unit/task/log helpers as a profile.
 */
export const SUPERVISOR_SERVICE_ID = 'supervisor';

export function serviceProfileId(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('profile name is required for service id');
  if (trimmed === '.' || trimmed === '..') throw new Error(`invalid profile name: ${profile}`);
  // ASCII-safe names pass through unchanged so existing service labels/paths
  // stay stable. Names with non-ASCII (e.g. Chinese 尼莫) or other OS-label-
  // unsafe chars get a deterministic ASCII-safe, unique id (sanitized base +
  // short hash) so any profile can still be installed as an OS daemon.
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  const base =
    trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 24) || 'profile';
  const hash = createHash('sha1').update(trimmed).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function serviceNameForProfile(profile: string = paths.profile): string {
  return `${SERVICE_NAME}.${serviceProfileId(profile)}`;
}

// === macOS launchd ===

export const LAUNCH_AGENT_LABEL = launchAgentLabel();

export function launchAgentLabel(profile: string = paths.profile): string {
  return `ai.${serviceNameForProfile(profile)}`;
}

/**
 * macOS convention: user LaunchAgents under `~/Library/LaunchAgents/`.
 * launchd discovers plists only from a few well-known paths.
 */
export function launchAgentPlistPath(profile: string = paths.profile): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel(profile)}.plist`);
}

// === Linux systemd (user units) ===

export const SYSTEMD_UNIT_NAME = systemdUnitName();

export function systemdUnitName(profile: string = paths.profile): string {
  return `${serviceNameForProfile(profile)}.service`;
}

/**
 * Linux convention: user systemd units under
 * `$XDG_CONFIG_HOME/systemd/user/`, defaulting to
 * `~/.config/systemd/user/` when XDG_CONFIG_HOME isn't set.
 */
export function systemdUnitPath(profile: string = paths.profile): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', systemdUnitName(profile));
}

// === Windows Task Scheduler ===

/**
 * schtasks task name. Backslashes turn into Task Scheduler "folders" so
 * `LarkChannelBridge\Bot` would create a Bot task under a LarkChannelBridge
 * folder. We keep it flat for now.
 */
export const WINDOWS_TASK_NAME = windowsTaskName();

export function windowsTaskName(profile: string = paths.profile): string {
  return `LarkChannelBridge.Bot.${serviceProfileId(profile)}`;
}

/**
 * The wrapper .cmd script schtasks invokes. schtasks `/TR` accepts a
 * command line directly, but we want stdout/stderr redirection + a PATH
 * override, which means wrapping in a script.
 */
export function windowsLauncherCmdPath(profile: string = paths.profile): string {
  return join(paths.appDir, 'daemon', serviceProfileId(profile), 'launcher.cmd');
}

// === Daemon log paths (platform-agnostic) ===

/**
 * Daemon stdout/stderr go alongside the bridge's own structured logs in
 * `~/.lark-channel/logs/` so users only need to remember one path. Filenames
 * are `daemon-*` to keep them distinct from the rolling per-day JSON files.
 */
export function daemonLogDir(profile: string = paths.profile): string {
  return join(resolveAppPaths({ rootDir: paths.rootDir, profile }).logsDir, 'daemon');
}

export function daemonStdoutPath(profile: string = paths.profile): string {
  return join(daemonLogDir(profile), 'daemon-stdout.log');
}

export function daemonStderrPath(profile: string = paths.profile): string {
  return join(daemonLogDir(profile), 'daemon-stderr.log');
}
