import * as p from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../agent/lark-channel-env';
import type { AppPaths } from '../config/app-paths';
import {
  type LarkCliConfig,
  type LarkCliIdentityPreset,
  type LarkCliUserImportStatus,
  type ProfileConfig,
} from '../config/profile-schema';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import {
  hasLarkCliUserAuth,
  hasStructuredLarkCliUserAuth,
} from '../lark-cli/identity-policy';
import { withLegacyLarkCliSourceOverlay } from '../lark-cli/legacy-source-overlay';
import { writeLarkCliSourceProjection } from '../lark-cli/profile-projection';
import { mergeProcessEnv, spawnProcess, spawnProcessSync } from '../platform/spawn';
import { writeFileAtomic } from '../platform/atomic-write';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const BIND_TIMEOUT_MS = 30 * 1000;

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const MANUAL_INSTALL_HINT = [
  'Manual install command:',
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  '',
  'Restart the current profile after installation; bridge will initialize lark-cli automatically.',
  '',
  'Docs: https://github.com/larksuite/cli',
].join('\n');

export interface PreFlightOptions {
  /** Skip lark-cli auto-install + bind. */
  skipCheckLarkCli?: boolean;
  larkChannel?: LarkChannelEnvContext;
  bridgeConfig?: AppConfig;
  profileConfig?: ProfileConfig;
  appPaths?: AppPaths;
}

export async function preFlightChecks(opts: PreFlightOptions): Promise<void> {
  await checkLarkCli(opts);
}

async function checkLarkCli(opts: PreFlightOptions): Promise<void> {
  if (opts.skipCheckLarkCli) return;
  const bridgeConfig = opts.bridgeConfig;
  const appPaths = opts.appPaths;
  const privateBinding = bridgeConfig !== undefined && appPaths !== undefined && opts.larkChannel !== undefined;
  if (privateBinding) {
    await writeLarkCliSourceProjection(bridgeConfig, appPaths);
  }
  const larkChannelEnv = opts.larkChannel ? buildLarkChannelEnv(opts.larkChannel) : undefined;
  const legacyLarkChannelEnv = opts.larkChannel
    ? buildLarkChannelEnv({ ...opts.larkChannel, larkCliConfigDir: undefined })
    : undefined;
  const profileArgs =
    privateBinding || !opts.larkChannel?.profile ? [] : ['--profile', opts.larkChannel.profile];

  if (!isLarkCliInstalled()) {
    console.log(
      [
        '',
        'lark-cli is not installed',
        '',
        'lark-cli is the Feishu/Lark command-line tool. After installation, the agent can:',
        '  - send interactive cards and forms',
        '  - query calendars, docs, tasks, OKRs, and attendance',
        '  - use 200+ Feishu/Lark API commands',
        '',
      ].join('\n'),
    );

    // Non-TTY (daemon / launchd / nohup / CI): don't auto-install — users
    // running headless typically don't expect a long network install to fire
    // under them. Print manual hint and continue startup.
    if (!process.stdin.isTTY) {
      console.log(`(non-interactive mode; skipping auto-install)\n\n${MANUAL_INSTALL_HINT}\n`);
      return;
    }

    p.intro('Setting up lark-cli');

    const sInstall = p.spinner();
    sInstall.start('Installing lark-cli');
    const installResult = await runCapture(
      'npm',
      ['install', '-g', '@larksuite/cli'],
      INSTALL_TIMEOUT_MS,
    );
    if (!installResult.success || !isLarkCliInstalled()) {
      sInstall.error('Install failed');
      if (installResult.output.trim()) {
        console.error(installResult.output);
      }
      p.outro('lark-cli installation did not complete');
      printInstallFailedWarning();
      return;
    }
    sInstall.stop('Installed');
  }

  if (privateBinding) {
    // Team mode: lark-cli must run bot-only and never carry a personal user.
    // Apply bot-only to lark-cli but do NOT persist identityPreset — the stored
    // value is the user's personal-mode choice, restored when switching back.
    if (opts.profileConfig?.mode === 'team') {
      const teamTarget = await readPrivateTarget(appPaths, bridgeConfig);
      if (!teamTarget.sameApp) {
        await bindLarkCliWithCompatibility(
          profileArgs,
          larkChannelEnv,
          appPaths,
          privateBinding,
          'bot-only',
        );
      } else if (teamTarget.identityPreset !== 'bot-only') {
        await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'bot-only');
      }
      return;
    }
    const target = await readPrivateTarget(appPaths, bridgeConfig);
    if (target.sameApp) {
      if (shouldSkipLocalUserImport(opts.profileConfig?.larkCli)) {
        if (target.identityPreset !== 'bot-only') {
          await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'bot-only');
        }
        await persistLarkCliConfig(opts, {
          identityPreset: 'bot-only',
          importStatus: 'not-needed',
          reason: 'manual-bot-only',
        });
      } else if (target.hasUserAuth) {
        if (target.identityPreset !== 'user-default') {
          const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'user-default');
          if (switchResult.success) {
            await persistLarkCliConfig(opts, {
              identityPreset: 'user-default',
              importStatus: 'skipped-existing-private-user',
              reason: 'existing-private-user',
            });
          } else {
            await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'bot-only');
            await persistLarkCliConfig(opts, {
              identityPreset: 'bot-only',
              importStatus: 'failed',
              reason: 'private-user-policy-switch-failed',
            });
          }
        } else {
          await persistLarkCliConfig(opts, {
            identityPreset: 'user-default',
            importStatus: 'skipped-existing-private-user',
            reason: 'existing-private-user',
          });
        }
      } else if (shouldAttemptLocalUserImport(opts)) {
        const localUser = await detectLocalSameAppUser(bridgeConfig, legacyLarkChannelEnv);
        if (localUser.status === 'imported') {
          await copyLocalUsersToPrivateTarget(appPaths, bridgeConfig, localUser.users);
          const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'user-default');
          if (switchResult.success && await privateSameAppUserReady(profileArgs, larkChannelEnv, bridgeConfig)) {
            await persistLarkCliConfig(opts, {
              identityPreset: 'user-default',
              importStatus: 'imported',
              reason: 'same-app-local-user',
            });
            return;
          }
          await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'bot-only');
          await persistLarkCliConfig(opts, {
            identityPreset: target.identityPreset ?? 'bot-only',
            importStatus: 'failed',
            reason: switchResult.success
              ? 'private-user-missing-after-switch'
              : 'local-user-policy-switch-failed',
          });
          return;
        } else {
          await persistLarkCliConfig(opts, {
            identityPreset: target.identityPreset ?? 'bot-only',
            importStatus: localUser.status,
            reason: localUser.reason,
          });
        }
      }

      const showResult = await runCapture(
        'lark-cli',
        [...profileArgs, 'config', 'show'],
        BIND_TIMEOUT_MS,
        larkChannelEnv,
      );
      if (showResult.success) return;
    }
  }

  if (!privateBinding) {
    const showResult = await runCapture(
      'lark-cli',
      [...profileArgs, 'config', 'show'],
      BIND_TIMEOUT_MS,
      larkChannelEnv,
    );
    if (showResult.success) return;
  }

  const localUser = privateBinding && shouldSkipLocalUserImport(opts.profileConfig?.larkCli)
    ? { status: 'not-needed' as const, reason: 'manual-bot-only' }
    : privateBinding && shouldAttemptLocalUserImport(opts)
      ? await detectLocalSameAppUser(bridgeConfig, legacyLarkChannelEnv)
      : { status: 'not-needed' as const, reason: 'not-private-binding' };
  const sBind = p.spinner();
  sBind.start('Initializing lark-cli configuration');
  const bindResult = await bindLarkCliWithCompatibility(
    profileArgs,
    larkChannelEnv,
    appPaths,
    privateBinding,
    'bot-only',
  );
  if (!bindResult.success) {
    sBind.error('lark-cli configuration failed');
    if (privateBinding) {
      await persistLarkCliConfig(opts, {
        identityPreset: 'bot-only',
        importStatus: localUser.status === 'imported' ? 'failed' : localUser.status,
        reason: 'bind-failed',
      });
    }
    printBindFailedWarning(bindResult, appPaths);
    return;
  }
  if (privateBinding) {
    if (localUser.status === 'imported') {
      await copyLocalUsersToPrivateTarget(appPaths, bridgeConfig, localUser.users);
      const switchResult = await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'user-default');
      if (switchResult.success && await privateSameAppUserReady(profileArgs, larkChannelEnv, bridgeConfig)) {
        await persistLarkCliConfig(opts, {
          identityPreset: 'user-default',
          importStatus: 'imported',
          reason: 'same-app-local-user',
        });
      } else {
        await switchLarkCliIdentityPolicy(profileArgs, larkChannelEnv, 'bot-only');
        await persistLarkCliConfig(opts, {
          identityPreset: 'bot-only',
          importStatus: 'failed',
          reason: switchResult.success
            ? 'private-user-missing-after-switch'
            : 'user-policy-switch-failed',
        });
      }
    } else {
      await persistLarkCliConfig(opts, {
        identityPreset: 'bot-only',
        importStatus: localUser.status,
        reason: localUser.reason,
      });
    }
  }
  sBind.stop('lark-cli configuration ready');
  p.outro('Done');
}

async function bindLarkCliWithCompatibility(
  profileArgs: string[],
  larkChannelEnv: NodeJS.ProcessEnv | undefined,
  appPaths: AppPaths | undefined,
  privateBinding: boolean,
  identityPreset: LarkCliIdentityPreset,
): Promise<RunResult> {
  const directResult = await runCapture(
    'lark-cli',
    [...profileArgs, 'config', 'bind', '--source', 'lark-channel', '--identity', identityPreset],
    BIND_TIMEOUT_MS,
    larkChannelEnv,
  );
  if (directResult.success) return directResult;

  if (
    privateBinding &&
    appPaths &&
    shouldUseLegacyLarkChannelSourceOverlay(directResult.output, appPaths)
  ) {
    return withLegacyLarkCliSourceOverlay(
      appPaths.configFile,
      appPaths.larkCliSourceConfigFile,
      () =>
        runCapture(
          'lark-cli',
          [...profileArgs, 'config', 'bind', '--source', 'lark-channel', '--identity', identityPreset],
          BIND_TIMEOUT_MS,
          larkChannelEnv,
        ),
    );
  }
  return directResult;
}

interface PrivateTargetStatus {
  sameApp: boolean;
  identityPreset?: LarkCliIdentityPreset;
  hasUserAuth: boolean;
}

async function readPrivateTarget(appPaths: AppPaths, cfg: AppConfig): Promise<PrivateTargetStatus> {
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === cfg.accounts.app.id &&
        candidate.brand === cfg.accounts.app.tenant,
    );
    if (!app) {
      return { sameApp: false, hasUserAuth: false };
    }
    if (typeof app.users === 'string') {
      app.users = null;
      try {
        await writeFileAtomic(appPaths.larkCliTargetConfigFile, `${JSON.stringify(raw, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch (err) {
        log.warn('lark-cli', 'private-target-repair-failed', {
          profile: appPaths.profile,
          err: errorMessage(err),
        });
      }
    }
    return {
      sameApp: true,
      identityPreset: larkCliIdentityPresetForTarget(app),
      hasUserAuth: hasStructuredLarkCliUserAuth(app.users),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sameApp: false, hasUserAuth: false };
    log.warn('lark-cli', 'private-target-read-failed', {
      profile: appPaths.profile,
      err: errorMessage(err),
    });
    return { sameApp: false, hasUserAuth: false };
  }
}

function larkCliIdentityPresetForTarget(app: {
  defaultAs?: string;
  strictMode?: string;
}): LarkCliIdentityPreset | undefined {
  if (app.defaultAs === 'bot' && app.strictMode === 'bot') return 'bot-only';
  if (app.defaultAs === 'auto' && app.strictMode === 'off') return 'user-default';
  return undefined;
}

function shouldSkipLocalUserImport(config: LarkCliConfig | undefined): boolean {
  return config?.identityPreset === 'bot-only' && config.localUserImport?.reason === 'manual-bot-only';
}

function shouldAttemptLocalUserImport(opts: PreFlightOptions): boolean {
  return opts.profileConfig !== undefined && !shouldSkipLocalUserImport(opts.profileConfig.larkCli);
}

async function privateSameAppUserReady(
  profileArgs: string[],
  larkChannelEnv: NodeJS.ProcessEnv | undefined,
  cfg: AppConfig,
): Promise<boolean> {
  const result = await runCapture(
    'lark-cli',
    [...profileArgs, 'config', 'show'],
    BIND_TIMEOUT_MS,
    larkChannelEnv,
  );
  if (!result.success) return false;
  const parsed = parseJsonObject(result.output);
  if (!parsed || typeof parsed !== 'object') return false;
  const app = parsed as { appId?: unknown; brand?: unknown; users?: unknown };
  return (
    app.appId === cfg.accounts.app.id &&
    app.brand === cfg.accounts.app.tenant &&
    hasLarkCliUserAuth(app.users)
  );
}

async function detectLocalSameAppUser(
  cfg: AppConfig,
  env?: NodeJS.ProcessEnv,
): Promise<{ status: LarkCliUserImportStatus; reason: string; users?: unknown }> {
  const result = await runCapture('lark-cli', ['config', 'show'], BIND_TIMEOUT_MS, env);
  if (!result.success) return { status: 'failed', reason: 'local-config-show-failed' };
  const parsed = parseJsonObject(result.output);
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'failed', reason: 'local-config-show-invalid-json' };
  }
  const local = parsed as {
    appId?: unknown;
    brand?: unknown;
    users?: unknown;
  };
  if (local.appId !== cfg.accounts.app.id || local.brand !== cfg.accounts.app.tenant) {
    return { status: 'skipped-no-local-user', reason: 'local-app-mismatch' };
  }
  if (!hasLarkCliUserAuth(local.users)) {
    return { status: 'skipped-no-local-user', reason: 'local-user-missing' };
  }
  const users = await readLocalSameAppUsers(result.output, cfg)
    ?? (hasStructuredLarkCliUserAuth(local.users) ? local.users : undefined);
  if (!users) {
    return { status: 'skipped-no-local-user', reason: 'local-user-unstructured' };
  }
  return {
    status: 'imported',
    reason: 'same-app-local-user',
    users,
  };
}

async function readLocalSameAppUsers(output: string, cfg: AppConfig): Promise<unknown | undefined> {
  const configPath = parseLarkCliConfigPath(output);
  if (!configPath) return undefined;
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === cfg.accounts.app.id &&
        candidate.brand === cfg.accounts.app.tenant,
    );
    return hasStructuredLarkCliUserAuth(app?.users) ? app?.users : undefined;
  } catch {
    return undefined;
  }
}

function parseLarkCliConfigPath(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => /^Config file path:\s*/i.test(candidate.trim()));
  const value = line?.replace(/^Config file path:\s*/i, '').trim();
  return value || undefined;
}

async function copyLocalUsersToPrivateTarget(
  appPaths: AppPaths,
  cfg: AppConfig,
  users: unknown,
): Promise<boolean> {
  if (!hasStructuredLarkCliUserAuth(users)) return false;
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === cfg.accounts.app.id &&
        candidate.brand === cfg.accounts.app.tenant,
    );
    if (!app || hasStructuredLarkCliUserAuth(app.users)) return false;
    app.users = users;
    await writeFileAtomic(appPaths.larkCliTargetConfigFile, `${JSON.stringify(raw, null, 2)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

async function switchLarkCliIdentityPolicy(
  profileArgs: string[],
  larkChannelEnv: NodeJS.ProcessEnv | undefined,
  identityPreset: LarkCliIdentityPreset,
): Promise<RunResult> {
  const strictMode = identityPreset === 'user-default' ? 'off' : 'bot';
  const defaultAs = identityPreset === 'user-default' ? 'auto' : 'bot';
  const strictResult = await runCapture(
    'lark-cli',
    [...profileArgs, 'config', 'strict-mode', strictMode],
    BIND_TIMEOUT_MS,
    larkChannelEnv,
  );
  if (!strictResult.success) return strictResult;
  return runCapture(
    'lark-cli',
    [...profileArgs, 'config', 'default-as', defaultAs],
    BIND_TIMEOUT_MS,
    larkChannelEnv,
  );
}

async function persistLarkCliConfig(
  opts: PreFlightOptions,
  update: {
    identityPreset: LarkCliIdentityPreset;
    importStatus: LarkCliUserImportStatus;
    reason: string;
  },
): Promise<void> {
  const appPaths = opts.appPaths;
  if (!appPaths) return;
  const now = new Date().toISOString();
  const localUserImport = {
    status: update.importStatus,
    attemptedAt: now,
    ...(update.importStatus === 'imported' ? { importedAt: now } : {}),
    reason: update.reason,
  };
  const nextLarkCli = {
    identityPreset: update.identityPreset,
    localUserImport,
  };
  let persistAttempted = false;
  let saveSucceeded = false;
  try {
    await withConfigFileLock(appPaths.configFile, async () => {
      const root = await loadRootConfig(appPaths.configFile);
      if (!root) return;
      const profile = root.profiles[appPaths.profile];
      if (!profile) return;
      root.profiles[appPaths.profile] = {
        ...profile,
        larkCli: nextLarkCli,
      };
      persistAttempted = true;
      await saveRootConfig(root, appPaths.configFile);
      saveSucceeded = true;
    });
  } catch (err) {
    log.warn('lark-cli', 'profile-config-persist-failed', {
      profile: appPaths.profile,
      err: errorMessage(err),
    });
    if (saveSucceeded && opts.profileConfig) {
      opts.profileConfig.larkCli = nextLarkCli;
    }
    return;
  }
  if (!persistAttempted) return;
  if (opts.profileConfig) {
    opts.profileConfig.larkCli = nextLarkCli;
  }
}

function printInstallFailedWarning(): void {
  console.error(
    [
      '',
      `${BOLD}╔════════════════════════════════════════════════════════════════╗${RESET}`,
      `${BOLD}║  lark-cli auto-install failed                                 ║${RESET}`,
      `${BOLD}╚════════════════════════════════════════════════════════════════╝${RESET}`,
      '',
      'Possible causes: network unavailable, npm global install permission denied, or registry failure.',
      '',
      'Bridge will keep running, but the agent may be unable to use Feishu/Lark tools.',
      'Run manually:',
      '',
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      '',
      'Docs: https://github.com/larksuite/cli',
      'After installation, restart bridge or rerun the current start command.',
      '',
    ].join('\n'),
  );
}

function printBindFailedWarning(result: RunResult, appPaths?: AppPaths): void {
  const profile = appPaths?.profile;
  const tooOld = isUnsupportedLarkChannelSource(result.output);
  const lines = tooOld
    ? [
        'The installed lark-cli does not support the lark-channel source required by bridge auto-configuration.',
        'Bridge will keep listening for messages, but the agent cannot use lark-cli to call Feishu/Lark APIs.',
        '',
        'Recovery:',
        '  1. Install a lark-cli build that supports the lark-channel source.',
        `  2. ${restartInstruction(profile)}`,
      ]
    : [
        'Bridge will keep listening for messages, but this profile did not finish lark-cli configuration.',
        'Impact: the agent may be unable to send messages, send cards, or call Feishu/Lark APIs through lark-cli.',
        '',
        'Recovery:',
        `  1. ${restartInstruction(profile)}`,
        '  2. If it still fails, check that this profile has a valid App Secret and that the lark-cli config directory is writable.',
      ];
  console.log(['', ...lines, '', 'Diagnostic details:', formatDiagnosticOutput(result.output), ''].join('\n'));
}

function restartInstruction(profile?: string): string {
  const suffix = profile ? ` --profile ${profile}` : '';
  return `Restart the current profile: lark-channel-bridge restart${suffix}; for foreground runs, press Ctrl+C and rerun lark-channel-bridge run${suffix}.`;
}

function shouldUseLegacyLarkChannelSourceOverlay(output: string, appPaths: AppPaths): boolean {
  if (isUnsupportedLarkChannelSource(output)) return false;
  if (!outputMentionsPath(output, appPaths.configFile)) return false;
  return (
    /accounts\.app\.id missing in /i.test(output) ||
    /cannot read .*config\.json/i.test(output) ||
    /no such file or directory/i.test(output)
  );
}

function outputMentionsPath(output: string, path: string): boolean {
  if (output.includes(path)) return true;
  return output.includes(JSON.stringify(path).slice(1, -1));
}

function isUnsupportedLarkChannelSource(output: string): boolean {
  return (
    /unknown flag:\s*--source/i.test(output) ||
    /unknown command ["']?bind["']?/i.test(output) ||
    /invalid --source[^-\n]*lark-channel/i.test(output) ||
    /unsupported source:\s*lark-channel/i.test(output) ||
    (/invalid --source[^-\n]*lark-channel/i.test(output) && /valid values:\s*\S+/i.test(output))
  );
}

function formatDiagnosticOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '(lark-cli did not print error details)';
  if (/unknown flag:\s*--source/i.test(trimmed) || /unknown command ["']?bind["']?/i.test(trimmed)) {
    return 'lark-cli does not support `config bind --source lark-channel`.';
  }
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    return JSON.stringify(stripLarkCliNotices(parsed), null, 2);
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => !isLarkCliUpdateNoticeLine(line));
  return lines.join('\n').trim() || '(lark-cli did not print error details)';
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) return parsed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return parseJson(trimmed.slice(start, end + 1));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripLarkCliNotices(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLarkCliNotices);
  if (!value || typeof value !== 'object') return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '_notice') continue;
    cleaned[key] = stripLarkCliNotices(child);
  }
  return cleaned;
}

function isLarkCliUpdateNoticeLine(line: string): boolean {
  return (
    /_notice/i.test(line) ||
    (/lark-cli/i.test(line) && /(update|upgrade|latest|newer|npm\s+install)/i.test(line)) ||
    /\b(current|latest)\s+version\b/i.test(line)
  );
}

function isLarkCliInstalled(): boolean {
  try {
    const result = spawnProcessSync('lark-cli', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

interface RunResult {
  success: boolean;
  /** Captured stdout + stderr from the child. Useful only on failure. */
  output: string;
}

/**
 * Run a child process, capture stdout/stderr to a buffer (keeps the
 * surrounding clack spinner UI clean), enforce a timeout. Used for the
 * npm install and lark-cli bind steps in the preflight check.
 */
async function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  let captured = '';
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawnProcess(cmd, args, {
      env: env ? mergeProcessEnv(process.env, env) : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { success: !timedOut && exitCode === 0, output: captured };
}
