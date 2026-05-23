import dns from 'node:dns';
import { createInterface } from 'node:readline';
import pkg from '../../../package.json';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { startChannel, type BridgeChannel } from '../../bot/channel';
import { runRegistrationWizard } from '../../bot/wizard';
import type { Controls } from '../../commands';
import { setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import type { AppConfig } from '../../config/schema';
import { getAgentModel, getPermissionMode, isComplete, secretKeyForApp } from '../../config/schema';
import {
  buildEncryptedAccountConfig,
  ensureSecretsGetterWrapper,
  loadConfig,
  saveConfig,
} from '../../config/store';
import { gcOldLogs, log } from '../../core/logger';
import { gcMediaCache } from '../../media/cache';
import { preFlightChecks } from '../preflight';
import {
  cleanupTmpFiles,
  register,
  sameAppOthers,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from '../../runtime/registry';
import { SessionStore } from '../../session/store';
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
});
process.on('uncaughtException', (err) => {
  log.fail('process', err, { kind: 'uncaughtException' });
});

const MEDIA_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StartOptions {
  config?: string;
  skipCheckLarkCli?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const configPath = opts.config ?? paths.configFile;
  const existing = await loadConfig(configPath);

  let cfg: AppConfig;
  if (isComplete(existing)) {
    cfg = existing;
    // Migrate legacy plaintext configs: any time we see a raw string in
    // accounts.app.secret that isn't a "${VAR}" template, move it into
    // the encrypted keystore and rewrite config.json with an exec ref.
    // Idempotent — already-encrypted configs (SecretRef) pass through.
    cfg = await maybeMigratePlaintextSecret(cfg, configPath);
  } else {
    const fresh = await runRegistrationWizard();
    // Fresh credentials from the wizard arrive as a plaintext secret;
    // immediately encrypt before persisting so disk never holds the raw value.
    cfg = await persistEncrypted(fresh, configPath);
    console.log(`配置已保存到 ${configPath}\n`);
  }

  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });

  const agent = new ClaudeAdapter({
    defaultPermissionMode: getPermissionMode(cfg),
    defaultModel: getAgentModel(cfg),
  });
  if (!(await agent.isAvailable())) {
    console.error('✗ 未找到 claude CLI。请先安装 Claude Code：');
    console.error('  https://docs.anthropic.com/en/docs/claude-code/quickstart');
    process.exit(1);
  }

  const sessions = new SessionStore();
  await sessions.load();
  const workspaces = new WorkspaceStore();
  await workspaces.load();

  await gcMediaCache(MEDIA_GC_MAX_AGE_MS);
  await gcOldLogs();

  // Same-app conflict detection. Open-platform routes events to one of the
  // long-connections at random, so two `start` of the same app makes "who
  // answered me" unpredictable. Warn + interactive triage before connecting.
  const conflicts = sameAppOthers(cfg.accounts.app.id);
  if (conflicts.length > 0) {
    const proceed = await resolveConflict(cfg, conflicts);
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
    configPath,
    version: pkg.version,
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
    unregisterSync(entry.id);
    process.exit(0);
  };

  const controls: Controls = {
    configPath,
    cfg,
    processId: entry.id,
    async exit() {
      await stop('exit-command');
    },
    async restart() {
      if (restarting) return;
      restarting = true;
      try {
        const next = await loadConfig(configPath);
        if (!isComplete(next)) throw new Error('config incomplete after change');
        console.log(
          `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`,
        );
        // Connect-before-disconnect: if the new bridge fails to come up
        // (e.g. network outage during a force-reconnect), throwing here
        // leaves the old bridge — and its keepalive timer — untouched, so
        // the next keepalive tick (~15s later) can retry restart. Without
        // this ordering, a failed restart would tear down the only
        // keepalive in the process and the bot would never recover until
        // someone manually restarts it.
        const next_bridge = await startChannel({
          cfg: next,
          agent,
          sessions,
          workspaces,
          controls,
        });
        console.log('[restart] disconnecting old bridge...');
        try {
          await bridge.disconnect();
        } catch (err) {
          console.warn('[restart] old disconnect failed:', err);
        }
        bridge = next_bridge;
        controls.cfg = next;
        // Keep the registry in sync so /ps reflects the new app after an
        // /account change. Same process id, new app fields.
        await updateEntry(entry.id, {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath,
          botName: bridge.channel.botIdentity?.name,
        }).catch((err) =>
          log.warn('registry', 'update-failed', { err: String(err) }),
        );
        console.log('✓ 已用新凭据重连');
      } finally {
        restarting = false;
      }
    },
  };

  bridge = await startChannel({ cfg, agent, sessions, workspaces, controls });

  // Backfill the bot's display name into the registry once WS handshake is
  // done — future starts conflicting on this app can show it in the prompt
  // ("bot 尼莫 (cli_xxx)") instead of just a short id.
  const botName = bridge.channel.botIdentity?.name;
  if (botName) {
    await updateEntry(entry.id, { botName }).catch((err) =>
      log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
    );
  }

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  // Last-ditch sync unregister in case something exits without going through
  // stop() (e.g. uncaughtException with process.exit(1)).
  process.on('exit', () => {
    unregisterSync(entry.id);
    cleanupTmpFiles();
  });

  // keep the event loop alive until a signal arrives
  await new Promise<void>(() => {});
}

/**
 * Print the same-app conflict, then ask the user how to proceed. Returns
 * true to continue starting (after killing the old ones), false to cancel.
 *
 * Non-TTY (launchd / systemd / piped) skips the prompt and warns — a service
 * manager can't answer questions, and erroring out by default would surprise
 * users running a daemon.
 */
async function resolveConflict(
  cfg: AppConfig,
  conflicts: ProcessEntry[],
): Promise<boolean> {
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

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

/**
 * If `cfg.accounts.app.secret` is a literal plaintext string (not a
 * "${VAR}" template, not a SecretRef), move it into the encrypted keystore
 * and rewrite `config.json` with an exec-provider SecretRef pointing at
 * the bridge. Returns the (possibly rewritten) cfg.
 *
 * Idempotent: configs already in the encrypted form return unchanged.
 */
async function maybeMigratePlaintextSecret(
  cfg: AppConfig,
  configPath: string,
): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;

  // Path A: still plaintext → encrypt + rewrite config.
  if (typeof s === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
      await saveConfig(next, configPath);
      console.log('🔒 已把 App Secret 加密迁移到 ~/.lark-channel/secrets.enc');
      return next;
    } catch (err) {
      log.warn('config', 'migrate-encrypted-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Migration failure isn't fatal — runtime resolver still handles
      // the plaintext path.
      return cfg;
    }
  }

  // Path B: env-template — leave entirely alone.
  if (typeof s === 'string') return cfg;

  // Path C: already a SecretRef. Two things to keep fresh:
  //   1. The wrapper script content (node / bridge paths may have moved).
  //   2. The config's `secrets.providers.bridge` block — older bridge
  //      versions wrote `command: <node path>`; the new format points
  //      at the wrapper. Rewrite if out of date so lark-cli's audit
  //      sees a user-owned, non-symlinked command path.
  try {
    const wrapperPath = await ensureSecretsGetterWrapper();
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
      );
      await saveConfig(next, configPath);
      console.log('🔒 已把 secrets provider 切到 wrapper 形态');
      return next;
    }
  } catch (err) {
    log.warn('config', 'wrapper-refresh-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cfg;
}

function needsProviderRewrite(cfg: AppConfig, wrapperPath: string): boolean {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}

/** Encrypt the (plaintext) secret from a freshly-wizard'd cfg and persist. */
async function persistEncrypted(cfg: AppConfig, configPath: string): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;
  if (typeof s !== 'string') {
    // Wizard returns plaintext today; if that ever changes, just save as-is.
    await saveConfig(cfg, configPath);
    return cfg;
  }
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
  await saveConfig(next, configPath);
  return next;
}

