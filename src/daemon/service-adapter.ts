import * as launchd from './launchd';
import { WINDOWS_TASK_NAME, launchAgentPlistPath, systemdUnitPath } from './paths';
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
  install(runArgs?: string[]): Promise<void>;

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

function makeLaunchdAdapter(): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: launchd.plistExists,
    isRunning: launchd.isLoaded,
    servicePath: launchAgentPlistPath,
    install: launchd.writePlist,
    start: launchd.bootstrap,
    stop: launchd.bootout,
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: launchd.bootout,
    restart: launchd.kickstart,
    waitUntilStopped: launchd.waitUntilUnloaded,
    deleteFile: launchd.deletePlist,
    describeStatus: launchd.describeService,
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: systemd.unitExists,
    isRunning: systemd.isActive,
    servicePath: systemdUnitPath,
    install: async (runArgs?: string[]) => {
      await systemd.writeUnit(runArgs);
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: systemd.enableAndStart,
    stop: systemd.stop,
    stopAndDisableAutostart: systemd.disableAndStop,
    restart: systemd.restart,
    waitUntilStopped: systemd.waitUntilInactive,
    deleteFile: async () => {
      await systemd.deleteUnit();
      systemd.daemonReload();
    },
    describeStatus: systemd.describeService,
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

function makeSchtasksAdapter(): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    fileExists: schtasks.isTaskRegistered,
    isRunning: schtasks.isTaskRunning,
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => WINDOWS_TASK_NAME,
    install: async (runArgs?: string[]) => {
      const r = await schtasks.installTask(runArgs);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    start: schtasks.runTask,
    stop: schtasks.endTask,
    stopAndDisableAutostart: schtasks.endAndDisable,
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    restart: schtasks.restartTask,
    waitUntilStopped: schtasks.waitUntilStopped,
    deleteFile: async () => {
      await schtasks.deleteTask();
    },
    describeStatus: schtasks.describeTask,
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
export function getServiceAdapter(): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter();
  if (process.platform === 'linux') return makeSystemdAdapter();
  if (process.platform === 'win32') return makeSchtasksAdapter();
  return null;
}
