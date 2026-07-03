import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveAppPaths } from './app-paths';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type CodexConfig,
  type PiConfig,
  type RootConfig,
} from './profile-schema';
import { markPermissionDefaultsMigration, saveRootConfig } from './profile-store';
import type { AppConfig } from './schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveWorkingDirectory } from '../policy/workspace';

export interface MigrateV2Options {
  rootDir?: string;
  profile?: string;
  configFile?: string;
  workspace?: string;
  agentKind?: AgentKind;
  codex?: CodexConfig;
  pi?: PiConfig;
}

export interface MigrateV2Result {
  migrated: boolean;
  profile: string;
}

interface LegacyConfig extends Partial<AppConfig> {
  app?: AppConfig['accounts']['app'];
  schemaVersion?: unknown;
}

interface RegistryFile {
  entries?: RegistryEntry[];
}

interface RegistryEntry {
  id?: unknown;
  pid?: unknown;
  appId?: unknown;
  tenant?: unknown;
  profileName?: unknown;
  agentKind?: unknown;
  configPath?: unknown;
  startedAt?: unknown;
  version?: unknown;
  botName?: unknown;
}

export interface ActiveBridgeMigrationProcess {
  id?: string;
  pid: number;
  appId?: string;
  tenant?: string;
  profileName?: string;
  agentKind?: AgentKind;
  configPath?: string;
  startedAt?: string;
  version?: string;
  botName?: string;
}

export class ActiveBridgeMigrationConflictError extends Error {
  constructor(readonly processes: ActiveBridgeMigrationProcess[]) {
    super(`active bridge process blocks v2 migration: ${formatActiveProcesses(processes)}`);
    this.name = 'ActiveBridgeMigrationConflictError';
  }
}

const STATE_ENTRIES = [
  'sessions.json',
  'workspaces.json',
  'secrets.enc',
  '.keystore.salt',
  'media',
  'logs',
] as const;

export async function migrateV1ToV2(opts: MigrateV2Options = {}): Promise<MigrateV2Result> {
  const paths = resolveAppPaths(opts);
  const profile = paths.profile;
  const configFile = opts.configFile ?? paths.configFile;

  let rawConfig: string;
  try {
    rawConfig = await readFile(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { migrated: false, profile };
    }
    throw err;
  }

  const parsed = JSON.parse(rawConfig) as LegacyConfig | RootConfig;
  if ((parsed as RootConfig).schemaVersion === 2) {
    return { migrated: false, profile: (parsed as RootConfig).activeProfile ?? profile };
  }

  await assertNoActiveOldProcesses([
    paths.userRegistryFile,
    join(paths.rootDir, 'processes.json'),
  ]);

  const legacy = parsed as LegacyConfig;
  const app = legacy.accounts?.app ?? legacy.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('legacy config is missing accounts.app');
  }

  const legacyDefaultWorkspace = opts.workspace
    ? await resolveBootstrapWorkspace(opts.workspace)
    : await collectLegacyDefaultWorkspace(paths.rootDir);
  const agentKind = opts.agentKind ?? 'claude';
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: { app },
    preferences: legacy.preferences,
    access: {
      ...legacy.preferences?.access,
      requireMentionInGroup: legacy.preferences?.requireMentionInGroup,
    },
    ...(agentKind === 'codex' && opts.codex ? { codex: opts.codex } : {}),
    ...(agentKind === 'pi' && opts.pi ? { pi: opts.pi } : {}),
  });
  if (legacyDefaultWorkspace) {
    profileConfig.workspaces = {
      ...profileConfig.workspaces,
      default: legacyDefaultWorkspace,
    };
  }

  const next: RootConfig = markPermissionDefaultsMigration({
    schemaVersion: 2,
    activeProfile: profile,
    preferences: {},
    ...(legacy.secrets ? { secrets: legacy.secrets } : {}),
    profiles: {
      [profile]: profileConfig,
    },
  }, profile);

  const moved: Array<{ from: string; to: string }> = [];
  try {
    await mkdir(paths.profileDir, { recursive: true });
    await copyFile(configFile, `${configFile}.bak`);
    await moveStateEntries(paths.rootDir, paths.profileDir, moved);
    await saveRootConfig(next, configFile);
    await writeFileAtomic(paths.activeProfileFile, `${profile}\n`, { mode: 0o600 });
    return { migrated: true, profile };
  } catch (err) {
    await rollbackMoves(moved);
    await writeFile(configFile, rawConfig, 'utf8').catch(() => {});
    await rm(paths.activeProfileFile, { force: true }).catch(() => {});
    throw err;
  }
}

async function assertNoActiveOldProcesses(registryFiles: string[]): Promise<void> {
  const active: ActiveBridgeMigrationProcess[] = [];
  for (const path of registryFiles) {
    active.push(...(await activeOldProcessesInFile(path)));
  }
  const unique = uniqueActiveProcesses(active);
  if (unique.length > 0) {
    throw new ActiveBridgeMigrationConflictError(unique);
  }
}

async function activeOldProcessesInFile(path: string): Promise<ActiveBridgeMigrationProcess[]> {
  let registry: RegistryFile;
  try {
    registry = JSON.parse(await readFile(path, 'utf8')) as RegistryFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const active: ActiveBridgeMigrationProcess[] = [];
  for (const entry of registry.entries ?? []) {
    if (typeof entry.pid !== 'number') continue;
    if (entry.pid === process.pid) continue;
    if (isAlive(entry.pid)) {
      active.push(activeProcessFromRegistryEntry(entry));
    }
  }
  return active;
}

function activeProcessFromRegistryEntry(entry: RegistryEntry): ActiveBridgeMigrationProcess {
  const active: ActiveBridgeMigrationProcess = { pid: entry.pid as number };
  if (typeof entry.id === 'string') active.id = entry.id;
  if (typeof entry.appId === 'string') active.appId = entry.appId;
  if (typeof entry.tenant === 'string') active.tenant = entry.tenant;
  if (typeof entry.profileName === 'string') active.profileName = entry.profileName;
  if (entry.agentKind === 'claude' || entry.agentKind === 'codex' || entry.agentKind === 'pi') {
    active.agentKind = entry.agentKind;
  }
  if (typeof entry.configPath === 'string') active.configPath = entry.configPath;
  if (typeof entry.startedAt === 'string') active.startedAt = entry.startedAt;
  if (typeof entry.version === 'string') active.version = entry.version;
  if (typeof entry.botName === 'string') active.botName = entry.botName;
  return active;
}

function uniqueActiveProcesses(processes: ActiveBridgeMigrationProcess[]): ActiveBridgeMigrationProcess[] {
  const seen = new Set<string>();
  const unique: ActiveBridgeMigrationProcess[] = [];
  for (const active of processes) {
    const key = `${active.pid}:${active.id ?? ''}:${active.configPath ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(active);
  }
  return unique;
}

function formatActiveProcesses(processes: ActiveBridgeMigrationProcess[]): string {
  return processes
    .map((active) => {
      const id = active.id ? ` id ${active.id}` : '';
      const app = active.appId ? ` app ${active.appId}` : '';
      return `pid ${active.pid}${id}${app}`;
    })
    .join(', ');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function moveStateEntries(
  rootDir: string,
  profileDir: string,
  moved: Array<{ from: string; to: string }>,
): Promise<void> {
  for (const name of STATE_ENTRIES) {
    const from = join(rootDir, name);
    const to = join(profileDir, name);
    if (!(await exists(from))) continue;
    if (await exists(to)) {
      throw new Error(`profile state already exists: ${to}`);
    }
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    moved.push({ from, to });
  }
}

async function rollbackMoves(moved: Array<{ from: string; to: string }>): Promise<void> {
  for (const item of moved.reverse()) {
    if (!(await exists(item.to))) continue;
    await mkdir(dirname(item.from), { recursive: true }).catch(() => {});
    await rename(item.to, item.from).catch(() => {});
  }
}

async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

export async function collectLegacyDefaultWorkspace(rootDir: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(rootDir, 'workspaces.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }

  const candidates = legacyWorkspaceCandidates(parsed);
  const imported: string[] = [];
  for (const candidate of candidates) {
    const workspace = await resolveWorkingDirectory(candidate);
    if (workspace.ok) imported.push(workspace.cwdRealpath);
  }
  return uniqueStrings(imported)[0];
}

function legacyWorkspaceCandidates(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const data = value as {
    chats?: Record<string, { cwd?: unknown }>;
    named?: Record<string, unknown>;
  };
  const candidates: string[] = [];
  for (const chat of Object.values(data.chats ?? {})) {
    if (typeof chat?.cwd === 'string') candidates.push(chat.cwd);
  }
  for (const cwd of Object.values(data.named ?? {})) {
    if (typeof cwd === 'string') candidates.push(cwd);
  }
  return uniqueStrings(candidates);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
