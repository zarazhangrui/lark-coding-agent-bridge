import { ClaudeAdapter } from '../../agent/claude/adapter';
import { isComplete } from '../../config/schema';
import { loadConfig } from '../../config/store';
import { daemonStderrPath, daemonStdoutPath } from '../../daemon/paths';
import {
  getServiceAdapter,
  type ServiceAdapter,
  type ServiceResultLike,
} from '../../daemon/service-adapter';
import { readAndPrune, type ProcessEntry } from '../../runtime/registry';
import { preFlightChecks } from '../preflight';

export interface ServiceStartOptions {
  /** Skip lark-cli auto-install + bind during `start`. */
  skipCheckLarkCli?: boolean;
}

/**
 * Resolve the adapter for the current platform, or exit with a helpful
 * message. All service-level commands gate on this.
 */
function requireAdapter(cmdName: string): ServiceAdapter {
  const adapter = getServiceAdapter();
  if (!adapter) {
    console.error(
      `${cmdName}: 当前系统不支持后台运行。`,
    );
    console.error('  目前支持: macOS (launchd) / Linux (systemd)');
    console.error('  Windows 支持后续版本。');
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

async function ensureBridgeConfigured(): Promise<void> {
  const cfg = await loadConfig();
  if (!isComplete(cfg)) {
    console.error('bot 还没配置 app 凭据。');
    console.error('请先运行 `run` 完成首次扫码向导,再回来 `start`。');
    process.exit(1);
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
  beforePids: ReadonlySet<number>,
  timeoutMs = 30_000,
): Promise<ProcessEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readAndPrune();
    const fresh = live.find(
      (e) => e.appId === appId && !beforePids.has(e.pid) && Boolean(e.botName),
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
  fn: () => ServiceResultLike,
): Promise<void> {
  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id ?? '';
  const beforePids = new Set(
    readAndPrune()
      .filter((e) => e.appId === appId)
      .map((e) => e.pid),
  );

  const r = await fn();
  if (!r.ok) {
    printServiceFailure(verb, r.stderr);
    process.exit(1);
  }

  const action = verb === 'started' ? '正在等待 bot 连接...' : '正在等待 bot 重新连接...';
  console.log(action);

  const entry = await waitForServiceConnect(appId, beforePids);
  if (entry) {
    const agent = new ClaudeAdapter();
    const verbZh = verb === 'started' ? '已启动' : '已重启';
    console.log(
      `✓ ${verbZh}  bot: ${entry.botName} (${entry.appId})  agent: ${agent.displayName} (${agent.id})  进程: ${entry.id}`,
    );
    return;
  }
  console.warn(`⚠ 已下发指令,但 30 秒内未观察到 bot 连接成功 (${verb})。`);
  console.warn(`  查看日志: tail -f ${daemonStderrPath()}`);
  console.warn(`              tail -f ${daemonStdoutPath()}`);
}

/**
 * `bridge start` — install (write file + reload) then start.
 *
 * Always re-installs so that `process.execPath` (current node binary)
 * and `process.env.PATH` reflect the user's current shell — important if
 * they've switched runtime versions or updated their PATH since last install.
 */
export async function runServiceStart(opts: ServiceStartOptions = {}): Promise<void> {
  const adapter = requireAdapter('start');
  await ensureBridgeConfigured();
  // Run the same lark-cli check as `bridge run` BEFORE writing the
  // service file — the user is in a TTY here and can answer the install
  // prompt. The daemon's own preflight (when launchd / systemd spawns
  // it) will be non-TTY and would silently skip the install.
  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });

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

  await reportConnectAfter('started', adapter.start);
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
export async function runServiceStop(): Promise<void> {
  const adapter = requireAdapter('stop');
  if (!adapter.fileExists()) {
    console.log('bot 还没在后台运行过,无需停止。');
    return;
  }
  if (!adapter.isRunning()) {
    console.log('bot 当前没在后台运行。');
    return;
  }

  // Snapshot bot info BEFORE stop so the success message can name
  // exactly which bot got stopped. Reading after would race the
  // unregisterSync the daemon fires on shutdown.
  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id;
  const entry = appId
    ? readAndPrune().find((e) => e.appId === appId && Boolean(e.botName))
    : undefined;

  const r = await adapter.stopAndDisableAutostart();
  if (!r.ok) {
    console.error(`✗ 停止失败:\n${formatServiceStderr(r.stderr)}`);
    process.exit(1);
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
export async function runServiceRestart(): Promise<void> {
  const adapter = requireAdapter('restart');
  if (!adapter.fileExists()) {
    console.error('bot 还没在后台运行过。请先运行 `start` 启动。');
    process.exit(1);
  }
  if (adapter.isRunning()) {
    await reportConnectAfter('restarted', adapter.restart);
    return;
  }
  await reportConnectAfter('started', adapter.start);
}

/** `bridge status` — report whether the daemon is running, with pid + log paths. */
export async function runServiceStatus(): Promise<void> {
  const adapter = requireAdapter('status');
  if (!adapter.fileExists()) {
    console.log('bot 当前没在后台运行(从未启动过)');
    console.log('  通过 `start` 启动 bot');
    return;
  }
  if (!adapter.isRunning()) {
    console.log('bot 当前没在后台运行');
    console.log('  通过 `start` 重新启动');
    return;
  }

  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id;
  // readAndPrune() drops entries whose pid is no longer alive, so `liveEntries`
  // reflects bot processes that are *actually* running right now.
  const liveEntries = appId
    ? readAndPrune().filter((e) => e.appId === appId)
    : readAndPrune();
  const entry = liveEntries.find((e) => Boolean(e.botName));

  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());

  if (entry) {
    console.log(`✓ bot ${entry.botName} (${entry.appId}) 正在后台运行`);
  } else if (liveEntries.length === 0) {
    // launchd reports the service "loaded", but no live bot process exists.
    // With KeepAlive=true a crash-looping bot keeps the launchd job alive while
    // nothing is actually serving — don't print a misleading "✓ 正在后台运行".
    console.log('⚠️  服务已加载,但当前没有存活的 bot 进程 — 可能在崩溃重启。');
    console.log('   请查看下方 daemon-stderr.log;若是 keystore 解密失败,');
    console.log('   跑 `lark-channel-bridge secrets set --app-id <你的 app id>` 重存后再 `restart`。');
  } else {
    console.log('✓ bot 正在后台运行');
  }
  if (pid) console.log(`  进程 ID: ${pid}`);
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath()}`);
  console.log(`    ${daemonStderrPath()}`);
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
export async function runServiceUnregister(): Promise<void> {
  const adapter = requireAdapter('unregister');
  if (!adapter.fileExists()) {
    console.log('bot 还没在后台运行过,无需清理。');
    return;
  }
  if (adapter.isRunning()) {
    const r = await adapter.stopAndDisableAutostart();
    if (!r.ok) {
      console.warn(`⚠ 停止 bot 时有警告(继续清理):\n${formatServiceStderr(r.stderr)}`);
    } else {
      console.log('✓ 已停止 bot');
    }
  }
  await adapter.deleteFile();
  console.log('✓ 已清除后台运行注册');
  console.log('  (配置 / 日志 / 会话保留在 ~/.lark-channel/)');
}
