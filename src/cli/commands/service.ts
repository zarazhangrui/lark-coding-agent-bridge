import { isComplete } from '../../config/schema';
import { createInterface } from 'node:readline';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { daemonStderrPath, daemonStdoutPath, SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import {
  getServiceAdapter,
  type ServiceAdapter,
  type ServiceResultLike,
} from '../../daemon/service-adapter';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../runtime/profile-runtime';
import { readAndPrune, type ProcessEntry } from '../../runtime/registry';
import { checkRuntimeLock, type RuntimeLockMeta } from '../../runtime/locks';
import { preFlightChecks } from '../preflight';
import { promptAndStopActiveBridgeMigrationConflict } from './migrate';
import { stopProcessEntry, type StopProcessEntryResult } from './ps';

export interface ServiceStartOptions {
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  /** Skip lark-cli auto-install + bind during `start`. */
  skipCheckLarkCli?: boolean;
  /** Install the supervisor+console service (`run --web-ui`) instead of a
   * single-profile service. */
  webUi?: boolean;
  confirmStopRuntimeLockProcess?: (meta: RuntimeLockMeta) => boolean | Promise<boolean>;
  stopRuntimeLockProcess?: (meta: RuntimeLockMeta) => StopProcessEntryResult | Promise<StopProcessEntryResult>;
}

export interface ServiceProfileOptions {
  profile?: string;
  /** Target the machine-wide supervisor service instead of a per-profile one. */
  webUi?: boolean;
}

/** CLI args a classic per-profile daemon launches with. Pinning `--profile`
 * keeps the service tied to its profile even if the active profile changes. */
function classicRunArgs(profile: string): string[] {
  return ['run', '--profile', profile];
}

/** CLI args the supervisor+console daemon launches with. */
const WEB_UI_RUN_ARGS = ['run', '--web-ui'];

/**
 * Resolve which OS service a lifecycle command (stop/restart/status/unregister)
 * targets: the machine-wide supervisor service (`--web-ui`) or a per-profile
 * classic one. `profile` is only set in the classic case (for botName lookup).
 */
async function resolveServiceTarget(
  opts: ServiceProfileOptions,
): Promise<{ serviceId: string; profile?: string; webUi: boolean }> {
  if (opts.webUi) return { serviceId: SUPERVISOR_SERVICE_ID, webUi: true };
  const profile = await resolveServiceProfile(opts.profile);
  return { serviceId: profile, profile, webUi: false };
}

/** Find the live registry entry (with botName) for a classic profile, if any. */
async function lookupProfileEntry(profile: string): Promise<ProcessEntry | undefined> {
  const runtime = await maybeResolveProfileRuntime(profile);
  const appId = runtime?.cfg.accounts?.app?.id;
  if (!appId) return undefined;
  return readAndPrune().find(
    (e) => e.appId === appId && e.profileName === profile && Boolean(e.botName),
  );
}

/**
 * Resolve the adapter for the current platform, or exit with a helpful
 * message. All service-level commands gate on this.
 */
function requireAdapter(cmdName: string, serviceId: string, runArgs?: string[]): ServiceAdapter {
  const adapter = getServiceAdapter(serviceId, runArgs);
  if (!adapter) {
    console.error(
      `${cmdName}: 当前系统不支持后台运行。`,
    );
    console.error('  目前支持: macOS (launchd) / Linux (systemd) / Windows (Task Scheduler)');
    process.exit(1);
  }
  return adapter;
}

/**
 * Strip the misleading "Try re-running the command as root for richer
 * errors" line that launchctl always appends — it's incorrect for our
 * per-user LaunchAgents domain. Running as root targets a different
 * domain (system-wide) and won't even see our plist.
 */
function formatServiceStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/re-running the command as root/i.test(line))
    .join('\n')
    .trim();
}

/**
 * Map common failure patterns to Chinese-language hints. Falls through
 * to the raw stderr (with platform-specific noise stripped) so power
 * users can still see the underlying problem.
 */
function printServiceFailure(verb: 'started' | 'restarted', stderr: string): void {
  const cleaned = formatServiceStderr(stderr);
  const action = verb === 'started' ? '启动' : '重启';

  if (/bootstrap failed.*input\/output error/i.test(cleaned)) {
    console.error(`✗ bot ${action}失败。`);
    console.error('');
    console.error('最常见原因:旧的 bot 实例还在收尾。请试以下任一种:');
    console.error('  1. 稍等几秒,重新运行 `start`');
    console.error('  2. 或彻底清除注册再启动:');
    console.error('       unregister');
    console.error('       start');
    console.error('');
    console.error('原始错误:');
    console.error(`  ${cleaned}`);
    return;
  }

  console.error(`✗ bot ${action}失败:`);
  console.error(cleaned);
}

async function ensureBridgeConfigured(
  opts: ServiceStartOptions,
): Promise<
  Pick<Awaited<ReturnType<typeof resolveProfileRuntime>>, 'profile' | 'cfg' | 'profileConfig' | 'appPaths' | 'configPath'>
> {
  const { cfg, profile, profileConfig, appPaths, configPath } = await resolveProfileRuntime({
    profile: opts.profile,
    agent: opts.agent,
    workspace: opts.workspace,
    appId: opts.appId,
    appSecret: opts.appSecret,
    tenant: opts.tenant,
    allowBootstrap: true,
    handleActiveBridgeMigrationConflict: async (err) => {
      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: '已取消启动。',
      });
      if (!handled) process.exit(0);
      return true;
    },
  });
  if (!isComplete(cfg)) {
    console.error('bot 还没配置 app 凭据。');
    console.error('请重新运行 `start` 完成首次扫码向导或传入已有应用信息。');
    process.exit(1);
  }
  return { profile, cfg, profileConfig, appPaths, configPath };
}

async function assertLockNotHeldByAnotherRuntime(
  kind: 'profile' | 'app',
  target: string,
  adapter: ServiceAdapter,
  opts: Pick<ServiceStartOptions, 'confirmStopRuntimeLockProcess' | 'stopRuntimeLockProcess'> = {},
): Promise<void> {
  for (;;) {
    const lock = await checkRuntimeLock(target);
    if (!lock.locked) return;

    const servicePid = adapter.isRunning() ? adapter.parseStatus(adapter.describeStatus()).pid : undefined;
    if (servicePid && lock.meta?.pid === Number(servicePid)) return;

    console.error(`✗ 当前 ${kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用。`);
    if (!lock.meta) {
      console.error(`  lock: ${target}`);
      console.error('  请先停止正在运行的占用进程，再执行 start。');
      process.exit(1);
    }
    const app = lock.meta.appId ? ` app=${lock.meta.appId}` : '';
    console.error(
      `  holder: profile=${lock.meta.profile}${app} agent=${lock.meta.agentKind} pid=${lock.meta.pid} startedAt=${lock.meta.startedAt}`,
    );

    if (!opts.confirmStopRuntimeLockProcess && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      console.error(
        `  非交互模式无法确认停止 ${kind === 'profile' ? 'profile' : 'app'} 占用进程。` +
          '请先用 `lark-channel-bridge ps` 查看并用 `lark-channel-bridge kill <bot id>` 停止后重试。',
      );
      process.exit(1);
    }

    const confirmed = opts.confirmStopRuntimeLockProcess
      ? await opts.confirmStopRuntimeLockProcess(lock.meta)
      : await confirmStopRuntimeLockProcess();
    if (!confirmed) {
      console.log('已取消启动。');
      process.exit(0);
    }

    const result = opts.stopRuntimeLockProcess
      ? await opts.stopRuntimeLockProcess(lock.meta)
      : await stopProcessEntry({ pid: lock.meta.pid });
    if (result === 'killed') {
      console.log(`✓ 已强制停止 pid ${lock.meta.pid}`);
    } else {
      console.log(`✓ 已停止 pid ${lock.meta.pid}`);
    }
  }
}

async function confirmStopRuntimeLockProcess(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question('是否停止旧进程并继续启动后台服务? [y/N]: ', resolve),
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Poll `~/.lark-channel/processes.json` for a freshly-registered bridge
 * instance whose appId matches our config and whose `botName` is filled —
 * the latter only happens AFTER the WS handshake to Feishu succeeds, so
 * by the time we see it the daemon is genuinely online.
 *
 * `beforePids` is the set of pids already running before we kicked off
 * the start/restart; we exclude them so the previous daemon instance
 * (in restart scenarios, briefly) or a separate foreground `run` doesn't
 * get misreported as our newly-spawned one.
 */
async function waitForServiceConnect(
  appId: string,
  profile: string,
  beforePids: ReadonlySet<number>,
  timeoutMs = 30_000,
): Promise<ProcessEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readAndPrune();
    const fresh = live.find(
      (e) =>
        e.appId === appId &&
        e.profileName === profile &&
        !beforePids.has(e.pid) &&
        Boolean(e.botName),
    );
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/**
 * Snapshot current pids for this app + invoke the OS service action +
 * wait for a fresh registry entry, then print the same connection line
 * `run` uses. Used by both `start` and `restart`.
 */
async function reportConnectAfter(
  verb: 'started' | 'restarted',
  profile: string,
  fn: () => ServiceResultLike,
): Promise<void> {
  const { cfg } = await resolveProfileRuntime({ profile, allowBootstrap: false });
  const appId = cfg.accounts?.app?.id ?? '';
  const beforePids = new Set(
    readAndPrune()
      .filter((e) => e.appId === appId && e.profileName === profile)
      .map((e) => e.pid),
  );

  const r = await fn();
  if (!r.ok) {
    printServiceFailure(verb, r.stderr);
    process.exit(1);
  }

  const action = verb === 'started' ? '正在等待 bot 连接...' : '正在等待 bot 重新连接...';
  console.log(action);

  const entry = await waitForServiceConnect(appId, profile, beforePids);
  if (entry) {
    const verbZh = verb === 'started' ? '已启动' : '已重启';
    const agent = agentDisplay(entry.agentKind);
    console.log(
      `✓ ${verbZh}  bot: ${entry.botName} (${entry.appId})  agent: ${agent.displayName} (${agent.id})  进程: ${entry.id}`,
    );
    return;
  }
  console.warn(`⚠ 已下发指令,但 30 秒内未观察到 bot 连接成功 (${verb})。`);
  console.warn(`  查看日志: tail -f ${daemonStderrPath(profile)}`);
  console.warn(`              tail -f ${daemonStdoutPath(profile)}`);
}

/**
 * `bridge start` — install (write file + reload) then start.
 *
 * Always re-installs so that `process.execPath` (current node binary)
 * and `process.env.PATH` reflect the user's current shell — important if
 * they've switched runtime versions or updated their PATH since last install.
 */
export async function runServiceStart(opts: ServiceStartOptions = {}): Promise<void> {
  if (opts.webUi) {
    await runServiceStartWebUi(opts);
    return;
  }
  const { profile, cfg, profileConfig, appPaths, configPath } = await ensureBridgeConfigured(opts);
  const adapter = requireAdapter('start', profile, classicRunArgs(profile));
  await assertLockNotHeldByAnotherRuntime('profile', appPaths.profileLockFile, adapter, opts);
  await assertLockNotHeldByAnotherRuntime('app', appPaths.appLockFile(cfg.accounts.app.id), adapter, opts);
  const materializedEnvSecret = await materializeEnvSecretForService({ profile });
  const bridgeConfig = materializedEnvSecret
    ? (await resolveProfileRuntime({ profile, allowBootstrap: false })).cfg
    : cfg;
  // Run the same lark-cli check as `bridge run` BEFORE writing the
  // service file — the user is in a TTY here and can answer the install
  // prompt. The daemon's own preflight (when launchd / systemd spawns
  // it) will be non-TTY and would silently skip the install.
  await preFlightChecks({
    skipCheckLarkCli: opts.skipCheckLarkCli,
    bridgeConfig,
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

  await adapter.install();

  // If already running, stop first so start operations don't race.
  if (adapter.isRunning()) {
    console.log('检测到旧 bot 实例,先停掉再重启...');
    const r = await adapter.stop();
    if (!r.ok) {
      console.warn(`⚠ 停止旧实例时有警告(继续重启):\n${formatServiceStderr(r.stderr)}`);
    }
    // Stop is async at the OS level (especially launchd) — wait until it
    // really takes effect before start, otherwise some platforms refuse.
    const ok = await adapter.waitUntilStopped();
    if (!ok) {
      console.error('✗ 旧 bot 实例没有完全停止。请稍后重试,或:');
      console.error('  unregister  # 强制清除注册');
      console.error('  start       # 再次启动');
      process.exit(1);
    }
  }

  await reportConnectAfter('started', profile, adapter.start);
}

/**
 * `bridge start --web-ui` — install + start the machine-wide supervisor+console
 * service. The daemon runs `run --web-ui`, which hosts every profile in one
 * process and serves the local web console. We preflight the active profile in
 * this TTY (the daemon's own run is non-interactive), install a single
 * supervisor-keyed service, then wait for the active profile to connect as a
 * health signal.
 *
 * Note: unlike classic start, we do NOT block on per-profile/app runtime locks
 * — the supervisor tolerates an individual profile failing to come online and
 * simply shows it offline in the console.
 */
async function runServiceStartWebUi(opts: ServiceStartOptions): Promise<void> {
  const { profile, cfg, profileConfig, appPaths, configPath } = await ensureBridgeConfigured(opts);
  const adapter = requireAdapter('start', SUPERVISOR_SERVICE_ID, WEB_UI_RUN_ARGS);
  await materializeEnvSecretForService({ profile });
  const bridgeConfig = (await resolveProfileRuntime({ profile, allowBootstrap: false })).cfg;

  // Same lark-cli check as classic `start`, in this TTY, before writing the
  // service file — the daemon's own preflight would be non-TTY and skip installs.
  await preFlightChecks({
    skipCheckLarkCli: opts.skipCheckLarkCli,
    bridgeConfig,
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

  await adapter.install();

  if (adapter.isRunning()) {
    console.log('检测到 supervisor 服务已在运行,先停掉再重启...');
    const r = await adapter.stop();
    if (!r.ok) {
      console.warn(`⚠ 停止旧 supervisor 时有警告(继续重启):\n${formatServiceStderr(r.stderr)}`);
    }
    const ok = await adapter.waitUntilStopped();
    if (!ok) {
      console.error('✗ 旧 supervisor 服务没有完全停止。请稍后重试,或:');
      console.error('  unregister --web-ui  # 强制清除注册');
      console.error('  start --web-ui       # 再次启动');
      process.exit(1);
    }
  }

  await reportConnectAfter('started', profile, adapter.start);
  console.log('  控制台由后台 supervisor 托管；用 `lark-channel-bridge ui` 打开');
}

/**
 * `bridge stop` — stop AND prevent auto-restart on next boot.
 *
 * Uses stopAndDisableAutostart so the semantics match on both platforms:
 *  - launchd: bootout (removes from launchd; KeepAlive / RunAtLoad off)
 *  - systemd: `disable --now` (stop + remove autostart symlinks)
 *
 * If the user just wants to bounce the service (keep autostart),
 * `restart` is the right command.
 */
export async function runServiceStop(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, profile, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('stop', serviceId);
  if (!adapter.fileExists()) {
    console.log(webUi ? 'supervisor 还没在后台运行过,无需停止。' : 'bot 还没在后台运行过,无需停止。');
    return;
  }
  if (!adapter.isRunning()) {
    console.log(webUi ? 'supervisor 当前没在后台运行。' : 'bot 当前没在后台运行。');
    return;
  }

  // Snapshot bot info BEFORE stop so the success message can name
  // exactly which bot got stopped. Reading after would race the
  // unregisterSync the daemon fires on shutdown. (Classic mode only —
  // the supervisor hosts many bots, so there's no single name.)
  const entry = !webUi && profile ? await lookupProfileEntry(profile) : undefined;

  const r = await adapter.stopAndDisableAutostart();
  if (!r.ok) {
    console.error(`✗ 停止失败:\n${formatServiceStderr(r.stderr)}`);
    process.exit(1);
  }
  if (webUi) {
    console.log('✓ 控制面 supervisor 已停止运行');
    console.log('  通过 `start --web-ui` 可再次重启');
    return;
  }
  if (entry) {
    console.log(`✓ bot ${entry.botName} (${entry.appId}) 已停止运行`);
  } else {
    console.log('✓ bot 已停止运行');
  }
  console.log('  通过 `start` 可再次重启');
}

/**
 * `bridge restart` — bounce the running daemon in place.
 *
 * If the service is not running (stopped or never started), behaves like
 * `start` and goes through the full install + start path.
 */
export async function runServiceRestart(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter(
    'restart',
    serviceId,
    webUi ? WEB_UI_RUN_ARGS : classicRunArgs(serviceId),
  );
  if (!adapter.fileExists()) {
    console.error(
      webUi
        ? 'supervisor 还没在后台运行过。请先运行 `start --web-ui` 启动。'
        : 'bot 还没在后台运行过。请先运行 `start` 启动。',
    );
    process.exit(1);
  }
  // Health-check waits on a profile connecting: classic → the service's own
  // profile; web-ui → whatever the supervisor auto-starts (the active profile).
  const waitProfile = webUi ? await resolveServiceProfile(undefined) : serviceId;
  if (adapter.isRunning()) {
    await reportConnectAfter('restarted', waitProfile, adapter.restart);
    return;
  }
  await reportConnectAfter('started', waitProfile, adapter.start);
}

/** `bridge status` — report whether the daemon is running, with pid + log paths. */
export async function runServiceStatus(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, profile, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('status', serviceId);
  const startHint = webUi ? '`start --web-ui`' : '`start`';
  const label = webUi ? '控制面 supervisor' : 'bot';
  if (!adapter.fileExists()) {
    console.log(`${label} 当前没在后台运行(从未启动过)`);
    console.log(`  通过 ${startHint} 启动`);
    return;
  }
  if (!adapter.isRunning()) {
    console.log(`${label} 当前没在后台运行`);
    console.log(`  通过 ${startHint} 重新启动`);
    return;
  }

  const entry = !webUi && profile ? await lookupProfileEntry(profile) : undefined;

  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());

  if (webUi) {
    console.log('✓ 控制面 supervisor 正在后台运行');
    const online = readAndPrune().filter((e) => Boolean(e.botName));
    if (online.length) {
      console.log(`  在线 bot: ${online.map((e) => e.botName).join('、')}`);
    }
  } else if (entry) {
    console.log(`✓ bot ${entry.botName} (${entry.appId}) 正在后台运行`);
  } else {
    console.log('✓ bot 正在后台运行');
  }
  if (pid) console.log(`  进程 ID: ${pid}`);
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath(serviceId)}`);
  console.log(`    ${daemonStderrPath(serviceId)}`);
  // -1 is launchd's "no meaningful exit recorded" marker; hide it.
  if (lastExit && lastExit !== '-1') console.log(`  上次退出码: ${lastExit}`);
}

/**
 * `bridge unregister` — stop, disable autostart, and remove the service
 * definition file.
 *
 * Idempotent. Leaves ~/.lark-channel/ state untouched (keystore, sessions,
 * logs etc) — that's the user's data, not service-manager hooks.
 */
export async function runServiceUnregister(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('unregister', serviceId);
  const label = webUi ? 'supervisor' : 'bot';
  if (!adapter.fileExists()) {
    console.log(`${label} 还没在后台运行过,无需清理。`);
    return;
  }
  if (adapter.isRunning()) {
    const r = await adapter.stopAndDisableAutostart();
    if (!r.ok) {
      console.warn(`⚠ 停止 ${label} 时有警告(继续清理):\n${formatServiceStderr(r.stderr)}`);
    } else {
      console.log(`✓ 已停止 ${label}`);
    }
  }
  await adapter.deleteFile();
  console.log('✓ 已清除后台运行注册');
  console.log(`  (配置 / 日志 / 会话保留在 ${paths.rootDir})`);
}

async function resolveServiceProfile(explicitProfile: string | undefined): Promise<string> {
  if (explicitProfile) return explicitProfile;
  const root = await loadRootConfig(paths.configFile);
  const profile = (await readActiveProfile(paths.rootDir)) ?? root?.activeProfile;
  if (!profile) {
    throw new Error('active profile is required for service command; pass --profile <name>');
  }
  if (root && !root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return profile;
}

async function maybeResolveProfileRuntime(
  profile: string,
): Promise<Awaited<ReturnType<typeof resolveProfileRuntime>> | undefined> {
  try {
    return await resolveProfileRuntime({ profile, allowBootstrap: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/profile not found|config not initialized|active profile is required/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}

function agentDisplay(agentKind: ProcessEntry['agentKind']): { id: string; displayName: string } {
  if (agentKind === 'codex') return { id: 'codex', displayName: 'Codex CLI' };
  if (agentKind === 'opencode') return { id: 'opencode', displayName: 'OpenCode' };
  return { id: 'claude', displayName: 'Claude Code' };
}
