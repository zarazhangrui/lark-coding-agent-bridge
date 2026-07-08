import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { paths } from '../config/paths';

/**
 * Logical service name — used as the launchd label AND as the systemd
 * unit name. Single-instance for now; if we ever support multiple bots
 * per machine the suffix can grow `.{appid}` without breaking installs.
 */
export const SERVICE_NAME = 'lark-channel-bridge.bot';

export function serviceProfileId(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('profile name is required for service id');
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
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

/**
 * Path to the persisted systemd service file in the bridge's own config
 * directory (~/.lark-channel/bot.<profile>.service). Written once by the
 * first `start` and read on subsequent starts so users can edit the unit
 * file without it being overwritten by the built-in template.
 */
export function channelUnitPath(profile: string = paths.profile, rootDir?: string): string {
  const base = rootDir ?? paths.rootDir;
  return join(base, `bot.${serviceProfileId(profile)}.service`);
}

export function daemonStderrPath(profile: string = paths.profile): string {
  return join(daemonLogDir(profile), 'daemon-stderr.log');
}
