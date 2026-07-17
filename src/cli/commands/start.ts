import dns from 'node:dns';
import os from 'node:os';
import { createInterface } from 'node:readline';
import pkg from '../../../package.json';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { CodexAdapter } from '../../agent/codex/adapter';
import {
  AgentPreflightError,
  formatAgentPreflightDiagnostic,
  type AgentAvailability,
} from '../../agent/preflight';
import type { AgentAdapter } from '../../agent/types';
import { startChannel, type BridgeChannel } from '../../bot/channel';
import type { Controls } from '../../commands';
import type { AppPaths } from '../../config/app-paths';
import {
  type AgentKind,
  type ProfileConfig,
} from '../../config/profile-schema';
import type { AppConfig } from '../../config/schema';
import { isComplete } from '../../config/schema';
import { configureLogger, gcOldLogs, log, reportError } from '../../core/logger';
import { loadTelemetryAdapter, telemetry } from '../../core/telemetry';
import { gcMediaCache } from '../../media/cache';
import { startUiServer } from '../../ui/server';
import { readUiSidecar, removeUiSidecar, writeUiSidecar } from '../../ui/sidecar';
import type { UiServerHandle } from '../../ui/types';
import { Supervisor } from '../../runtime/supervisor';
import { acquireHostLock } from '../../runtime/host-lock';
import { preFlightChecks } from '../preflight';
import { promptAndStopActiveBridgeMigrationConflict } from './migrate';
import { stopProcessEntry, type StopProcessEntryResult } from './ps';
import {
  cleanupTmpFiles,
  register,
  sameAppLiveOthers,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from '../../runtime/registry';
import {
  acquireAppRuntimeLock,
  RuntimeLockConflictError,
  withProfileAndAppLocks,
  type AcquiredRuntimeLock,
  type RuntimeLockMeta,
} from '../../runtime/locks';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  releaseRuntimeLocks,
} from '../../runtime/agent-runtime';
import { refreshOwnerControls } from '../../policy/owner';

// Re-exported for existing tests that import these from this module.
export { assertReconnectAgentKindUnchanged, createRuntimeAgent };
import { SessionStore } from '../../session/store';
import { SessionCatalog } from '../../session/catalog';
import { WorkspaceStore } from '../../workspace/store';

// Prefer IPv4 — Node 20+ defaults to "verbatim" which respects whatever
// the resolver returns first; in IPv6-broken networks (WSL2, certain VPNs,
// some hotel WiFi) this lands on a dead v6 route and stalls. Explicitly
// prefer v4 avoids that whole class of issue.
dns.setDefaultResultOrder('ipv4first');

// Process-level safety net: never let a stray SDK call / axios timeout
// take the whole bot down. Most outbound calls (channel.send / rawClient.*)
// are async; if any callsite misses a try/catch (or fires an update after
// its enclosing scope returned), the rejection bubbles to here. Log and
// keep the bot alive — losing a single reply is better than crashing.
process.on('unhandledRejection', (reason) => {
  log.fail('process', reason, { kind: 'unhandledRejection' });
  reportError(reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  log.fail('process', err, { kind: 'uncaughtException' });
  reportError(err, { kind: 'uncaughtException' });
});

const MEDIA_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StartOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  skipCheckLarkCli?: boolean;
  /** Start the machine-wide supervisor + web console instead of a single
   * profile in the foreground. Default false → classic headless run. */
  webUi?: boolean;
  confirmStopRuntimeLockProcess?: (err: RuntimeLockConflictError) => boolean | Promise<boolean>;
  stopRuntimeLockProcess?: (meta: RuntimeLockMeta) => StopProcessEntryResult | Promise<StopProcessEntryResult>;
}

/**
 * Foreground bridge entry.
 *
 *  - `run` / `run --profile X` → **classic**: one profile in the foreground,
 *    no web console, headless-safe (works on servers without a browser).
 *  - `run --web-ui` → **supervisor console**: one machine-wide process hosting
 *    all profiles + a local web console to start/stop/configure them.
 */
export async function runStart(opts: StartOptions): Promise<void> {
  if (opts.webUi) {
    await runSupervisorConsole(opts);
    return;
  }
  await runClassic(opts);
}

const migrationConflictHandler = async (err: unknown): Promise<boolean> => {
  const handled = await promptAndStopActiveBridgeMigrationConflict(err as never, {
    cancelMessage: '已取消启动。',
  });
  if (!handled) process.exit(0);
  return true;
};

/**
 * Classic single-profile foreground run (the pre-supervisor default). Uses the
 * Supervisor internally to host exactly one profile — no host lock (so multiple
 * classic runs coexist in separate terminals) and no web console. Fails loudly
 * if the profile can't come online.
 */
async function runClassic(opts: StartOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: migrationConflictHandler,
  });
  const { cfg, configPath, appPaths } = runtime;
  configureLogger({ logsDir: appPaths.logsDir });
  await loadTelemetryAdapter({
    version: pkg.version,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    hostname: os.hostname(),
  });
  await gcOldLogs();

  const supervisor = new Supervisor({ configPath, rootDir: appPaths.rootDir });

  // Retry loop: on a profile/app runtime-lock conflict, offer to stop the
  // holder and try again (same UX as older single-profile `run`).
  for (;;) {
    try {
      await supervisor.startProfile(appPaths.profile);
      break;
    } catch (err) {
      const action = await handleRuntimeLockConflict(err, opts);
      if (action === 'retry') continue;
      if (action === 'cancel') {
        process.exit(0);
      }
      throw err; // unhandled → surfaced to the CLI top-level handler (exit 1)
    }
  }
  console.log(`✓ profile「${appPaths.profile}」已上线（前台运行，Ctrl-C 退出）`);

  await parkWithShutdown(supervisor, appPaths, undefined, undefined);
}

/**
 * Supervisor console mode: one process per machine hosting every profile, with
 * a local web console. A second `run --web-ui` / `start --web-ui` detects the
 * running control plane and prints its URL instead of launching a duplicate.
 */
async function runSupervisorConsole(opts: StartOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: migrationConflictHandler,
  });
  const cfg = runtime.cfg;
  const configPath = runtime.configPath;
  const appPaths = runtime.appPaths;
  configureLogger({ logsDir: appPaths.hostLogsDir });

  // One supervisor per machine. If one is already running, print its console
  // URL and exit instead of launching a duplicate.
  const hostLock = await acquireHostLock(appPaths.hostLockFile);
  if (!hostLock) {
    const sidecar = await readUiSidecar(appPaths.hostUiFile);
    console.log(
      sidecar
        ? `控制面已在运行：${sidecar.url}`
        : '控制面已在运行（另一个 supervisor 进程持有锁）。',
    );
    return;
  }

  await loadTelemetryAdapter({
    version: pkg.version,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    hostname: os.hostname(),
  });
  await gcOldLogs();

  const supervisor = new Supervisor({ configPath, rootDir: appPaths.rootDir });

  // Single web console (host sidecar), backed by the supervisor.
  let uiServer: UiServerHandle | undefined;
  try {
    uiServer = await startUiServer({ supervisor, version: pkg.version, rootDir: appPaths.rootDir });
    await writeUiSidecar(appPaths.hostUiFile, uiServer, new Date().toISOString());
    console.log(`✓ 控制台：${uiServer.url}`);
  } catch (err) {
    log.warn('ui', 'server-start-failed', { err: String(err) });
  }

  // Auto-start only the active profile; others start on demand from the console.
  try {
    await supervisor.startProfile(appPaths.profile);
    console.log(`✓ profile「${appPaths.profile}」已上线`);
  } catch (err) {
    console.warn(
      `⚠️ active profile「${appPaths.profile}」启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
    log.warn('supervisor', 'active-start-failed', { profile: appPaths.profile, err: String(err) });
  }

  await parkWithShutdown(supervisor, appPaths, uiServer, hostLock);
}

/**
 * Install the one-time signal / exit handlers and park the process forever
 * (until a signal triggers shutdown). Shared by both modes; console mode passes
 * a `uiServer` + `hostLock` to also tear those down, classic mode passes
 * neither. Returns a promise that never resolves so the caller stays parked.
 */
function parkWithShutdown(
  supervisor: Supervisor,
  appPaths: AppPaths,
  uiServer: UiServerHandle | undefined,
  hostLock: { release(): Promise<void> } | undefined,
): Promise<void> {
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，正在关闭...`);
    if (uiServer) {
      await uiServer.close().catch(() => {});
      await removeUiSidecar(appPaths.hostUiFile);
    }
    await supervisor.shutdown();
    if (hostLock) await hostLock.release().catch(() => {});
    await flushTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => {
    void flushTelemetry();
  });
  process.on('exit', () => {
    supervisor.unregisterAllSync();
    cleanupTmpFiles(appPaths.userRegistryFile);
  });

  return new Promise<void>(() => {});
}


/**
 * Print the same-app conflict, then ask the user how to proceed. Returns
 * true to continue starting (after killing the old ones), false to cancel.
 *
 * Non-TTY (launchd / systemd / piped) skips the prompt and warns — a service
 * manager can't answer questions, and erroring out by default would surprise
 * users running a daemon.
 */
async function resolveConflict(conflicts: ProcessEntry[]): Promise<boolean> {
  console.log(
    `⚠️  检测到这个飞书应用已经有 ${conflicts.length} 个 bot 正在运行:`,
  );
  for (const e of conflicts) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    // botName 只在 WS 连上后才回填,刚启动 / 连接失败的旧 entry 可能没有。
    const label = e.botName ? `bot ${e.botName} (${e.appId})` : `bot ${e.appId}`;
    console.log(`   - ${label},进程 ${e.id},${ago}启动`);
  }
  console.log('');

  if (!process.stdin.isTTY) {
    console.warn(
      '⚠️  当前不是交互式启动,已自动取消。如需替换,先用 `kill <bot id>` 关掉旧的。\n',
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
  try {
    const verb = conflicts.length > 1 ? '它们' : '那个';
    const answer = (await ask(`继续启动会先关掉${verb},是否继续? [y/N]: `))
      .trim()
      .toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      return false;
    }
    for (const e of conflicts) {
      try {
        process.kill(e.pid, 'SIGTERM');
        console.log(`✓ 已关掉 bot ${e.id}`);
      } catch (err) {
        console.warn(`✗ 关掉 bot ${e.id} 失败:${(err as Error).message}`);
      }
    }
    // Brief wait so targets unregister themselves before we register on top.
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } finally {
    rl.close();
  }
}

type RuntimeLockConflictAction = 'retry' | 'cancel' | 'unhandled';

async function handleRuntimeLockConflict(
  err: unknown,
  opts: StartOptions,
): Promise<RuntimeLockConflictAction> {
  if (!(err instanceof RuntimeLockConflictError)) return 'unhandled';
  console.error(`✗ 当前 ${err.kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用。`);
  if (err.meta) {
    const app = err.meta.appId ? ` app=${err.meta.appId}` : '';
    console.error(
      `  holder: profile=${err.meta.profile}${app} agent=${err.meta.agentKind} pid=${err.meta.pid} startedAt=${err.meta.startedAt}`,
    );
  } else {
    console.error(`  lock: ${err.target}`);
    return 'unhandled';
  }

  const confirmed = opts.confirmStopRuntimeLockProcess
    ? await opts.confirmStopRuntimeLockProcess(err)
    : await confirmStopRuntimeLockProcess(err);
  if (!confirmed) {
    console.log('已取消启动。');
    return 'cancel';
  }

  const result = opts.stopRuntimeLockProcess
    ? await opts.stopRuntimeLockProcess(err.meta)
    : await stopProcessEntry({ pid: err.meta.pid });
  if (result === 'killed') {
    console.log(`✓ 已强制停止 pid ${err.meta.pid}`);
  } else {
    console.log(`✓ 已停止 pid ${err.meta.pid}`);
  }
  return 'retry';
}

async function confirmStopRuntimeLockProcess(err: RuntimeLockConflictError): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `当前 ${err.kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用；` +
        '非交互模式无法确认停止，请先用 `lark-channel-bridge ps` 查看并用 `lark-channel-bridge kill <bot id>` 停止后重试',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await new Promise<string>((resolve) =>
      rl.question('是否停止旧进程并重新启动? [y/N]: ', resolve),
    ))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  try {
    await telemetry().flush?.(timeoutMs);
  } catch {
    /* best effort during shutdown */
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}
