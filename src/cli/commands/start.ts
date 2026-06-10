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
import { refreshOwnerControls } from '../../policy/owner';
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
  confirmStopRuntimeLockProcess?: (err: RuntimeLockConflictError) => boolean | Promise<boolean>;
  stopRuntimeLockProcess?: (meta: RuntimeLockMeta) => StopProcessEntryResult | Promise<StopProcessEntryResult>;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...opts,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: async (err) => {
      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: '已取消启动。',
      });
      if (!handled) process.exit(0);
      return true;
    },
  });
  let cfg = runtime.cfg;
  const configPath = runtime.configPath;
  const appPaths = runtime.appPaths;
  let profileConfig = runtime.profileConfig;
  configureLogger({ logsDir: appPaths.logsDir });

  await preFlightChecks({
    skipCheckLarkCli: opts.skipCheckLarkCli,
    bridgeConfig: cfg,
    profileConfig,
    appPaths,
    larkChannel: {
      profile: appPaths.profile,
      rootDir: appPaths.rootDir,
      configPath,
      larkCliConfigDir: appPaths.larkCliConfigDir,
      larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
    },
  });

  await loadTelemetryAdapter({
    version: pkg.version,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    hostname: os.hostname(),
  });

  let agent = createRuntimeAgent(profileConfig, { ...appPaths, configPath });
  const availability = await checkRuntimeAgentAvailability(agent);
  if (!availability.ok) {
    console.error(formatAgentPreflightDiagnostic(availability.diagnostic));
    log.warn('agent', 'preflight-failed', { diagnostic: availability.diagnostic });
    process.exit(1);
  }

  for (;;) {
    try {
      let runtimeLocks: AcquiredRuntimeLock[] = [];
      await withProfileAndAppLocks(
        appPaths,
        cfg.accounts.app.id,
        cfg.agentKind ?? 'claude',
        async (locks) => {
          runtimeLocks = locks;
          const sessions = new SessionStore(appPaths.sessionsFile);
          await sessions.load();
          const sessionCatalog = new SessionCatalog(`${appPaths.sessionsFile}.catalog.json`);
          await sessionCatalog.load();
          const workspaces = new WorkspaceStore(appPaths.workspacesFile);
          await workspaces.load();

        await gcMediaCache(MEDIA_GC_MAX_AGE_MS, appPaths.mediaDir);
        await gcOldLogs();

        // Same-app conflict detection. Open-platform routes events to one of the
        // long-connections at random, so two `start` of the same app makes "who
        // answered me" unpredictable. Warn + interactive triage before connecting.
        const conflicts = await sameAppLiveOthers(
          cfg.accounts.app.id,
          process.pid,
          appPaths.userRegistryFile,
        );
        if (conflicts.length > 0) {
          const proceed = await resolveConflict(conflicts);
          if (!proceed) {
            console.log('已取消启动。');
            process.exit(0);
          }
        }

        // Register self in the process registry. Cleanup is wired via stop() and
        // 'exit' below — both paths run unregisterSync so stale entries don't
        // poison the next start.
        const entry = await register({
          appId: cfg.accounts.app.id,
          tenant: cfg.accounts.app.tenant,
          profileName: appPaths.profile,
          agentKind: cfg.agentKind ?? 'claude',
          configPath,
          version: pkg.version,
          registryFile: appPaths.userRegistryFile,
        });
        log.info('registry', 'registered', { id: entry.id, pid: process.pid });

        // `bridge` is mutable so /account can swap it on restart. `controls` carries
        // restart() and a snapshot of the current cfg so command handlers can read
        // and replace credentials without plumbing through the whole runStart scope.
        let bridge: BridgeChannel;
        let restarting = false;

        let stopping = false;
        const stop = async (sig: string): Promise<void> => {
          if (stopping) return;
          stopping = true;
          console.log(`\n收到 ${sig}，正在关闭...`);
          try {
            await bridge.disconnect();
          } catch (err) {
            console.error('[disconnect-failed]', err);
          }
          // unregister is best-effort sync — we're about to exit anyway.
          unregisterSync(entry.id, appPaths.userRegistryFile);
          await releaseRuntimeLocks(runtimeLocks);
          await flushTelemetry();
          process.exit(0);
        };

        let controls: Controls;
        const makeControls = (
          currentPaths: AppPaths,
          currentCfg: AppConfig,
          currentProfileConfig: ProfileConfig,
        ): Controls => {
          const currentControls: Controls = {
            profile: currentPaths.profile,
            profileConfig: currentProfileConfig,
            ownerRefreshState: 'unknown',
            knownChats: [],
            async refreshOwner(channelOverride) {
              const target = channelOverride ?? bridge?.channel;
              if (!target) return;
              await refreshOwnerControls(
                currentControls,
                target,
                currentControls.cfg.accounts.app.id,
              );
            },
            configPath,
            cfg: currentCfg,
            processId: entry.id,
            async exit() {
              await stop('exit-command');
            },
            async restart() {
              if (restarting) return;
              restarting = true;
              let nextAppLock: AcquiredRuntimeLock | undefined;
              try {
                const nextRuntime = await resolveProfileRuntime({
                  config: configPath,
                  profile: appPaths.profile,
                  allowBootstrap: false,
                });
                const next = nextRuntime.cfg;
                if (!isComplete(next)) throw new Error('config incomplete after change');
                assertReconnectAgentKindUnchanged(cfg.agentKind, next.agentKind);
                const nextAgent = createRuntimeAgent(nextRuntime.profileConfig, {
                  ...nextRuntime.appPaths,
                  configPath: nextRuntime.configPath,
                });
                const nextAvailability = await checkRuntimeAgentAvailability(nextAgent);
                if (!nextAvailability.ok) {
                  throw nextAvailability.error;
                }
                const appChanged = next.accounts.app.id !== cfg.accounts.app.id;
                if (appChanged) {
                  nextAppLock = await acquireAppRuntimeLock(
                    nextRuntime.appPaths,
                    next.accounts.app.id,
                    next.agentKind ?? 'claude',
                  );
                }
                console.log(
                  `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`,
                );
                const nextControls = makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
                // Connect-before-disconnect: if the new bridge fails to come up
                // (e.g. network outage during a force-reconnect), throwing here
                // leaves the old bridge — and its keepalive timer — untouched, so
                // the next keepalive tick (~15s later) can retry restart. Without
                // this ordering, a failed restart would tear down the only
                // keepalive in the process and the bot would never recover until
                // someone manually restarts it.
                const next_bridge = await startChannel({
                  cfg: next,
                  agent: nextAgent,
                  sessions,
                  sessionCatalog,
                  workspaces,
                  controls: nextControls,
                  appPaths: nextRuntime.appPaths,
                });
                console.log('[restart] disconnecting old bridge...');
                try {
                  await bridge.disconnect();
                } catch (err) {
                  console.warn('[restart] old disconnect failed:', err);
                }
                bridge = next_bridge;
                // Update while the old app lock is still held. Registry write paths
                // prune stale entries by matching the currently persisted app lock.
                await updateEntry(entry.id, {
                  appId: next.accounts.app.id,
                  tenant: next.accounts.app.tenant,
                  configPath,
                  botName: bridge.channel.botIdentity?.name,
                }, appPaths.userRegistryFile).catch((err) =>
                  log.warn('registry', 'update-failed', { err: String(err) }),
                );
                if (nextAppLock) {
                  const oldAppLock = runtimeLocks.find((lock) => lock.kind === 'app');
                  runtimeLocks = [
                    ...runtimeLocks.filter((lock) => lock.kind !== 'app'),
                    nextAppLock,
                  ];
                  nextAppLock = undefined;
                  await oldAppLock?.release().catch((err) =>
                    log.warn('runtime-lock', 'old-app-release-failed', { err: String(err) }),
                  );
                }
                cfg = next;
                profileConfig = nextRuntime.profileConfig;
                agent = nextAgent;
                controls = nextControls;
                console.log('✓ 已用新凭据重连');
              } finally {
                if (nextAppLock) {
                  await nextAppLock.release().catch((err) =>
                    log.warn('runtime-lock', 'new-app-release-failed', { err: String(err) }),
                  );
                }
                restarting = false;
              }
            },
          };
          return currentControls;
        };
        controls = makeControls(appPaths, cfg, profileConfig);

        bridge = await startChannel({
          cfg,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          controls,
          appPaths,
        });

        // Backfill the bot's display name into the registry once WS handshake is
        // done — future starts conflicting on this app can show it in the prompt
        // ("bot 尼莫 (cli_xxx)") instead of just a short id.
        const botName = bridge.channel.botIdentity?.name;
        if (botName) {
          await updateEntry(entry.id, { botName }, appPaths.userRegistryFile).catch((err) =>
            log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
          );
        }

        process.on('SIGINT', () => void stop('SIGINT'));
        process.on('SIGTERM', () => void stop('SIGTERM'));
        process.on('beforeExit', () => {
          void flushTelemetry();
        });
        // Last-ditch sync unregister in case something exits without going through
        // stop() (e.g. uncaughtException with process.exit(1)).
        process.on('exit', () => {
          unregisterSync(entry.id, appPaths.userRegistryFile);
          cleanupTmpFiles(appPaths.userRegistryFile);
        });

        // keep the event loop alive until a signal arrives
          await new Promise<void>(() => {});
        },
      );
      return;
    } catch (err) {
      const action = await handleRuntimeLockConflict(err, opts);
      if (action === 'retry') continue;
      if (action === 'cancel') return;
      throw err;
    }
  }
}

async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: agent.id === 'codex' ? 'codex' as const : 'claude' as const,
    agentName: agent.displayName,
    command: agent.id === 'codex' ? 'codex' : 'claude',
  };
  return {
    ok: false,
    diagnostic,
    error: new AgentPreflightError(diagnostic),
  };
}

export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  return new ClaudeAdapter({ larkChannel });
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

async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await lock.release().catch((err) =>
      log.warn('runtime-lock', 'release-failed', {
        kind: lock.kind,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
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
