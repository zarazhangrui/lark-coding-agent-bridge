import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath, windowsTaskName } from './paths';
import * as schtasks from './schtasks';
import * as systemd from './systemd';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

/** Some platforms' restart is sync (spawnSync), others (schtasks) are
 * naturally async. Adapter methods can return either; callers await. */
export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

/**
 * Platform-agnostic interface over OS service managers (launchd / systemd /
 * schtasks). All methods are best-effort idempotent — calling stop()
 * on an already-stopped service returns ok=true.
 */
export interface ServiceAdapter {
  /** Display name used in error / status messages. */
  readonly platformName: string;

  /** Whether the service file (plist / unit / task) is on disk / registered. */
  fileExists(): boolean;

  /** Whether the service is currently running (process alive). */
  isRunning(): boolean;

  /** Path/name to the service definition (for status output). */
  servicePath(): string;

  /** Write or overwrite the service definition. */
  install(): Promise<void>;

  /** Start the service (enables autostart where applicable). */
  start(): ServiceResultLike;

  /** Stop the service. Does NOT disable autostart on its own. */
  stop(): ServiceResultLike;

  /** Stop + disable autostart. Used by `unregister` flow. */
  stopAndDisableAutostart(): ServiceResultLike;

  /** Restart the running service in place. */
  restart(): ServiceResultLike;

  /** Poll until the service is no longer running, or timeout. */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;

  /** Remove the service definition from the OS. */
  deleteFile(): Promise<void>;

  /** Raw status output from the underlying tool, for downstream parsing. */
  describeStatus(): string;

  /**
   * Extract pid / last exit code from `describeStatus()` text. Returns
   * undefined for fields the platform doesn't expose or hasn't recorded yet.
   */
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: () => launchd.plistExists(profile),
    isRunning: () => launchd.isLoaded(profile),
    servicePath: () => launchAgentPlistPath(profile),
    install: () => launchd.writePlist(profile),
    start: () => launchd.bootstrap(profile),
    stop: () => launchd.bootout(profile),
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: () => launchd.bootout(profile),
    restart: async () => {
      await launchd.writePlist(profile);
      return launchd.kickstart(profile);
    },
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(profile, timeoutMs),
    deleteFile: () => launchd.deletePlist(profile),
    describeStatus: () => launchd.describeService(profile),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: () => systemd.unitExists(profile),
    isRunning: () => systemd.isActive(profile),
    servicePath: () => systemdUnitPath(profile),
    install: async () => {
      await systemd.writeUnit(profile);
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(profile),
    stop: () => systemd.stop(profile),
    stopAndDisableAutostart: () => systemd.disableAndStop(profile),
    restart: async () => {
      await systemd.writeUnit(profile);
      systemd.daemonReload();
      return systemd.restart(profile);
    },
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(profile, timeoutMs),
    deleteFile: async () => {
      await systemd.deleteUnit(profile);
      systemd.daemonReload();
    },
    describeStatus: () => systemd.describeService(profile),
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

function makeSchtasksAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    fileExists: () => schtasks.isTaskRegistered(profile),
    isRunning: () => schtasks.isTaskRunning(profile),
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => windowsTaskName(profile),
    install: async () => {
      const r = await schtasks.installTask(profile);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    start: () => schtasks.runTask(profile),
    stop: () => schtasks.endTask(profile),
    stopAndDisableAutostart: () => schtasks.endAndDisable(profile),
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    // Rewrite the launcher .cmd first so current node/PATH/env are captured.
    restart: async () => {
      await schtasks.writeLauncherCmd(profile);
      return schtasks.restartTask(profile);
    },
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(profile, timeoutMs),
    deleteFile: async () => {
      await schtasks.deleteTask(profile);
    },
    describeStatus: () => schtasks.describeTask(profile),
    parseStatus: (text) => ({
      // `Process ID: <n>` shows up in verbose listing only when task is running.
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      // `Last Result: <0|nonzero>` — `0` means last run succeeded.
      // Filter the `1056` ("task already running") and `267011` ("task hasn't
      // run") sentinels that aren't real exit codes.
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1],
    }),
  };
}

/**
 * Return the right adapter for the current platform, or null if this OS
 * isn't supported. Callers should null-check and surface a friendly error.
 */
export function getServiceAdapter(profile = 'claude'): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(profile);
  if (process.platform === 'linux') return makeSystemdAdapter(profile);
  if (process.platform === 'win32') return makeSchtasksAdapter(profile);
  return null;
}
