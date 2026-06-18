import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import {
  loadRootConfig,
  agentKindFromString,
  formatRootConfig,
  hasPermissionDefaultsMigration,
  markPermissionDefaultsMigration,
  readActiveProfile,
  removeProfile,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
  writeActiveProfile,
} from '../../config/profile-store';
import type { RootConfig } from '../../config/profile-schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { writeFileAtomic } from '../../platform/atomic-write';
import { acquireProfileRuntimeLock, checkRuntimeLock } from '../../runtime/locks';
import { readAndPrune } from '../../runtime/registry';
import { listAllProfiles } from '../../runtime/profile-discovery';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';

export interface ProfileCommandOptions {
  rootDir?: string;
}

export interface ProfileCreateOptions extends ProfileCommandOptions {
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  reuseActiveApp?: boolean;
}

export interface ProfileRemoveOptions extends ProfileCommandOptions {
  purge?: boolean;
  yes?: boolean;
  now?: () => Date;
}

export interface ProfileExportOptions extends ProfileCommandOptions {
  output?: string;
  force?: boolean;
  includeSecrets?: boolean;
  yes?: boolean;
}

export async function runProfileList(opts: ProfileCommandOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  let profiles;
  try {
    profiles = await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('root config not found:')) throw err;
    console.log('暂无 profile。');
    return;
  }

  const registryFile = resolveAppPaths({ rootDir }).userRegistryFile;
  const running = readAndPrune(registryFile);
  const rows = profiles.map((profile) => {
    const holders = running
      .filter((entry) => entry.profileName === profile.name)
      .map((entry) => `pid=${entry.pid} agent=${entry.agentKind}`);
    return {
      active: profile.active ? '*' : '',
      profile: profile.name,
      agent: profile.agentKind === 'antigravity' ? 'agy' : profile.agentKind,
      status: holders.length > 0 ? holders.join(', ') : '-',
    };
  });
  const widths = {
    active: Math.max('ACTIVE'.length, ...rows.map((row) => row.active.length)),
    profile: Math.max('PROFILE'.length, ...rows.map((row) => row.profile.length)),
    agent: Math.max('AGENT'.length, ...rows.map((row) => row.agent.length)),
  };
  console.log(formatProfileListRow({
    active: 'ACTIVE',
    profile: 'PROFILE',
    agent: 'AGENT',
    status: 'STATUS',
  }, widths));
  for (const row of rows) {
    console.log(formatProfileListRow(row, widths));
  }
}

function formatProfileListRow(
  row: { active: string; profile: string; agent: string; status: string },
  widths: { active: number; profile: number; agent: number },
): string {
  return [
    row.active.padEnd(widths.active),
    row.profile.padEnd(widths.profile),
    row.agent.padEnd(widths.agent),
    row.status,
  ].join('  ');
}

export async function runProfileCreate(
  name: string,
  opts: ProfileCreateOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    const existing = root?.profiles[name];
    if (existing) {
      const requested = agentKindFromString(opts.agent);
      if (requested && existing.agentKind !== requested) {
        throw new Error(
          `profile ${name} already exists with agentKind ${existing.agentKind}, ` +
            `but profile create requested --agent ${requested}. ` +
            `Profile names are labels; use the existing ${existing.agentKind} profile, ` +
            `choose another name, or remove profile ${name} before creating a ${requested} profile.`,
        );
      }
      throw new Error(`profile already exists: ${name}`);
    }

    await resolveProfileRuntime({
      config: configFile,
      profile: name,
      agent: opts.agent,
      workspace: opts.workspace,
      appId: opts.appId,
      appSecret: opts.appSecret,
      tenant: opts.tenant,
      reuseActiveApp: opts.reuseActiveApp,
      allowBootstrap: true,
    });
  });
  console.log(`已创建 profile: ${name}`);
}

export async function runProfileUse(
  name: string,
  opts: ProfileCommandOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    if (!root?.profiles[name]) throw new Error(`profile not found: ${name}`);
    root.activeProfile = name;
    await saveRootConfig(root, configFile);
    await writeActiveProfile(rootDir, name);
  });
  console.log(`已切换到 profile: ${name}`);
}

export async function runProfileRemove(
  name: string,
  opts: ProfileRemoveOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  if (opts.purge && !opts.yes) {
    throw new Error('profile remove --purge requires --yes');
  }
  const configFile = resolveAppPaths({ rootDir }).configFile;
  await withConfigFileLock(configFile, async () => {
    const root = await loadRootConfig(configFile);
    if (!root) throw new Error('config not initialized');
    const profile = root.profiles[name];
    if (!profile) throw new Error(`profile not found: ${name}`);
    const activeProfile = await readActiveProfile(rootDir);
    if (activeProfile) {
      if (!root.profiles[activeProfile]) {
        throw new Error(`active profile not found: ${activeProfile}; run profile use <name> to repair`);
      }
      root.activeProfile = activeProfile;
    }
    const profilePaths = resolveAppPaths({ rootDir, profile: name });
    const profileLock = await checkRuntimeLock(profilePaths.profileLockFile);
    if (profileLock.locked) {
      const holder = profileLock.meta ? ` pid=${profileLock.meta.pid}` : '';
      throw new Error(`profile is locked/running: ${name}${holder}`);
    }
    const lock = await acquireProfileRuntimeLock(profilePaths, profile.agentKind);
    try {
      const result = await removeProfile(root, name, rootDir, {
        purge: opts.purge,
        now: opts.now,
      });
      try {
        if (Object.keys(result.root.profiles).length === 0) {
          await rm(configFile, { force: true });
          await rm(resolveAppPaths({ rootDir }).activeProfileFile, { force: true });
        } else {
          await saveRootConfig(result.root, configFile);
          await writeActiveProfile(rootDir, result.root.activeProfile);
        }
      } catch (err) {
        if (result.restore) {
          try {
            await result.restore();
            await saveRootConfig(root, configFile);
            await writeActiveProfile(rootDir, root.activeProfile);
          } catch (restoreErr) {
            throw new Error(
              `profile remove failed after moving ${name}; state is at ${result.archivedTo}. ` +
                `restore failed: ${String((restoreErr as Error).message ?? restoreErr)}. ` +
                `root config error: ${String((err as Error).message ?? err)}`,
            );
          }
        }
        throw err;
      }
      if (result.purged) {
        await result.cleanup?.();
        console.log(`已永久删除 profile: ${name}`);
        return;
      }
      console.log(`已归档 profile: ${name} -> ${result.archivedTo}`);
    } finally {
      await lock.release().catch(() => {});
    }
  });
}

export async function runProfileExport(
  name: string,
  opts: ProfileExportOptions = {},
): Promise<void> {
  if (opts.includeSecrets && !opts.yes) {
    throw new Error('profile export --include-secrets requires --yes');
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  if (!root) throw new Error('config not initialized');
  const selected = root.profiles[name];
  if (!selected) throw new Error(`profile not found: ${name}`);

  const profile = cloneJson(selected);
  if (opts.includeSecrets) {
    profile.accounts.app.secret = await resolveAppSecret(
      runtimeProfileConfig(root, name),
      resolveAppPaths({ rootDir, profile: name }),
    );
  }
  const exportedBase: RootConfig = {
    schemaVersion: 2,
    activeProfile: name,
    preferences: {},
    ...(opts.includeSecrets && root.secrets ? { secrets: cloneJson(root.secrets) } : {}),
    profiles: {
      [name]: profile,
    },
  };
  const exported = hasPermissionDefaultsMigration(root, name)
    ? markPermissionDefaultsMigration(exportedBase, name)
    : exportedBase;
  if (!opts.includeSecrets) {
    delete profile.secrets;
    profile.accounts.app.secret = '[REDACTED]';
  }
  const body = formatRootConfig(exported);

  if (!opts.output) {
    console.log(body.trimEnd());
    return;
  }
  if (existsSync(opts.output) && !opts.force) {
    throw new Error('output already exists; use --force');
  }
  await writeFileAtomic(opts.output, body, { mode: 0o600 });
  console.log(`已导出 profile: ${name} -> ${opts.output}`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
