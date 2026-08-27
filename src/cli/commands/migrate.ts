import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { t } from '../../i18n';
import { createBootstrapCodexConfig } from '../profile-bootstrap';
import { promptLine } from '../prompt';
import { stopProcessEntry } from './ps';
import {
  ActiveBridgeMigrationConflictError,
  migrateV1ToV2,
  type ActiveBridgeMigrationProcess,
  type MigrateV2Options,
  type MigrateV2Result,
} from '../../config/migrate-v2';
import { legacyPaths, paths } from '../../config/paths';
import { agentKindFromString } from '../../config/profile-store';
import type { RootConfig } from '../../config/profile-schema';
import { isComplete, type AppCredentials, type AppConfig } from '../../config/schema';
import { saveConfig } from '../../config/store';

export interface MigrateOptions {
  config?: string;
  profile?: string;
  agent?: string;
  confirmStopActiveBridgeProcesses?: (
    processes: ActiveBridgeMigrationProcess[],
  ) => Promise<boolean> | boolean;
  stopActiveBridgeProcesses?: (processes: ActiveBridgeMigrationProcess[]) => Promise<void> | void;
}

interface LegacyShape {
  app?: AppCredentials;
}

/**
 * One-shot migrator for two pre-0.1.11 changes:
 *
 *  1. Path: ~/.config/lark-channel-bridge/ + ~/.cache/lark-channel-bridge/
 *     → ~/.lark-channel/
 *  2. Shape: { app: {...} } → { accounts: { app: {...} } }
 *
 * Idempotent — running on an already-migrated setup is a no-op.
 */
export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const configPath = opts.config ?? paths.configFile;
  await migrateLegacyPaths();
  await migrateConfigShape(configPath);
  const agentKind = agentKindFromString(opts.agent) ?? (opts.profile === 'codex' ? 'codex' : undefined);
  const needsV2Migration = await hasLegacyProfileConfig(configPath);
  const result = await migrateProfileV2WithActiveBridgePrompt({
    rootDir: dirname(configPath),
    configFile: configPath,
    profile: opts.profile,
    ...(agentKind ? { agentKind } : {}),
    ...(needsV2Migration && agentKind === 'codex'
      ? { codex: await createBootstrapCodexConfig(undefined) }
      : {}),
  }, opts);
  if (!result) return;
  if (result.migrated) {
    console.log(t('migrate.profileUpgraded', { profile: result.profile }));
  } else {
    console.log(t('migrate.profileUpToDate', { profile: result.profile }));
  }
}

async function migrateProfileV2WithActiveBridgePrompt(
  migrateOptions: MigrateV2Options,
  commandOptions: MigrateOptions,
): Promise<MigrateV2Result | undefined> {
  for (;;) {
    try {
      return await migrateV1ToV2(migrateOptions);
    } catch (err) {
      if (!(err instanceof ActiveBridgeMigrationConflictError)) throw err;
      if (commandOptions.confirmStopActiveBridgeProcesses) {
        const confirmed = await commandOptions.confirmStopActiveBridgeProcesses(err.processes);
        if (!confirmed) {
          console.log(t('migrate.cancelled'));
          return undefined;
        }
        if (commandOptions.stopActiveBridgeProcesses) {
          await commandOptions.stopActiveBridgeProcesses(err.processes);
        } else {
          await stopActiveBridgeProcesses(err.processes);
        }
        continue;
      }

      const handled = await promptAndStopActiveBridgeMigrationConflict(err, {
        cancelMessage: t('migrate.cancelled'),
      });
      if (!handled) return undefined;
    }
  }
}

export async function promptAndStopActiveBridgeMigrationConflict(
  err: ActiveBridgeMigrationConflictError,
  options: { cancelMessage?: string } = {},
): Promise<boolean> {
  const confirmed = await confirmStopActiveBridgeProcesses(err.processes);
  if (!confirmed) {
    if (options.cancelMessage) console.log(options.cancelMessage);
    return false;
  }
  await stopActiveBridgeProcesses(err.processes);
  return true;
}

async function confirmStopActiveBridgeProcesses(
  processes: ActiveBridgeMigrationProcess[],
): Promise<boolean> {
  console.log(t('migrate.activeProcesses'));
  for (const active of processes) {
    console.log(`  - ${formatActiveBridgeProcess(active)}`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(t('migrate.nonInteractiveError'));
  }

  const answer = (await promptLine(t('migrate.confirmStop'))).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function stopActiveBridgeProcesses(processes: ActiveBridgeMigrationProcess[]): Promise<void> {
  for (const active of processes) {
    console.log(t('migrate.stopping', { proc: formatActiveBridgeProcess(active) }));
    const result = await stopProcessEntry(active);
    if (result === 'killed') {
      console.log(t('cli.killedPid', { pid: active.pid }));
    } else {
      console.log(t('cli.stoppedPid', { pid: active.pid }));
    }
  }
}

function formatActiveBridgeProcess(active: ActiveBridgeMigrationProcess): string {
  const label = active.botName
    ? `bot ${active.botName}`
    : active.appId
      ? `app ${active.appId}`
      : 'bridge';
  const id = active.id ? ` id=${active.id}` : '';
  const profile = active.profileName ? ` profile=${active.profileName}` : '';
  return `${label}${id}${profile} pid=${active.pid}`;
}

async function hasLegacyProfileConfig(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  return !isRootConfigV2(JSON.parse(raw));
}

async function migrateLegacyPaths(): Promise<void> {
  const legacyConfig = await pathExists(legacyPaths.appDir);
  const legacyCache = await pathExists(legacyPaths.cacheDir);

  if (!legacyConfig && !legacyCache) return;

  await mkdir(paths.appDir, { recursive: true });

  if (legacyConfig) {
    await moveDirContents(legacyPaths.appDir, paths.appDir);
    await rmIfEmpty(legacyPaths.appDir);
    console.log(t('migrate.movedConfig', { from: legacyPaths.appDir, to: paths.appDir }));
  }
  if (legacyCache) {
    // Move media subdirectory if present.
    const legacyMedia = join(legacyPaths.cacheDir, 'media');
    if (await pathExists(legacyMedia)) {
      await moveDirContents(legacyMedia, paths.mediaDir);
      await rmIfEmpty(legacyMedia);
    }
    // Move anything else at the top level too.
    await moveDirContents(legacyPaths.cacheDir, paths.appDir);
    await rmIfEmpty(legacyPaths.cacheDir);
    console.log(t('migrate.movedCache', { from: legacyPaths.cacheDir, to: paths.appDir }));
  }
}

async function migrateConfigShape(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(t('migrate.noConfigJson'));
      return;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(t('migrate.invalidJson', { path }), err);
    process.exit(1);
  }

  if (isRootConfigV2(parsed)) {
    console.log(t('migrate.configIsV2', { path }));
    return;
  }

  const obj = parsed as Partial<AppConfig> & LegacyShape;

  if (isComplete(obj)) {
    console.log(t('migrate.configIsNew', { path }));
    return;
  }

  if (obj.app?.id && obj.app.secret && obj.app.tenant) {
    const next: AppConfig = { accounts: { app: obj.app } };
    await saveConfig(next, path);
    console.log(t('migrate.configUpgraded', { path }));
    console.log('  { app: ... } → { accounts: { app: ... } }');
    return;
  }

  console.error(t('migrate.unknownConfigFormat', { path }));
  console.error(t('migrate.expectedFormat'));
  process.exit(1);
}

function isRootConfigV2(value: unknown): value is RootConfig {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Partial<RootConfig>).schemaVersion === 2 &&
      (value as Partial<RootConfig>).profiles &&
      typeof (value as Partial<RootConfig>).profiles === 'object',
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveDirContents(from: string, to: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(from);
  } catch {
    return;
  }
  await mkdir(to, { recursive: true });
  for (const name of entries) {
    const src = join(from, name);
    const dst = join(to, name);
    if (await pathExists(dst)) {
      console.log(t('migrate.skippedExisting', { name }));
      continue;
    }
    await rename(src, dst);
  }
}

async function rmIfEmpty(p: string): Promise<void> {
  try {
    const remaining = await readdir(p);
    if (remaining.length === 0) await rm(p, { recursive: false });
  } catch {
    /* best effort */
  }
}
