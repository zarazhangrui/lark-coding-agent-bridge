import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { resolveAppPaths } from '../config/app-paths';
import { paths } from '../config/paths';
import type { AgentKind } from '../config/profile-schema';
import type { TenantBrand } from '../config/schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { checkRuntimeLock } from './locks';

/**
 * Tracks running `lark-channel-bridge start` processes so we can:
 *   - Warn on duplicate `start` of the same app (open-platform routes events
 *     to one of N long-connections randomly, leaving users guessing).
 *   - Let users list (`ps` / `/ps`) and terminate (`stop <id>` / `/exit <id>`)
 *     a specific process.
 *
 * Single-machine only — entries live in a local JSON file. Read-only views
 * never rewrite registry state; mutating paths take a registry-file lock,
 * prune stale entries using runtime lock state, then rewrite atomically.
 */

export interface ProcessEntry {
  /** 4-char random hex, stable for this process's lifetime. */
  id: string;
  pid: number;
  appId: string;
  tenant: TenantBrand;
  profileName: string;
  agentKind: AgentKind;
  configPath: string;
  startedAt: string;
  version: string;
  /** Bot's display name (e.g. "尼莫"). Filled in by startChannel after the
   * WS handshake — undefined until the connection is up, or on processes
   * registered by older versions of the bridge. */
  botName?: string;
}

interface RegistryFile {
  entries: ProcessEntry[];
}

const EMPTY: RegistryFile = { entries: [] };

function isValidEntry(e: unknown): e is ProcessEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.pid === 'number' &&
    typeof x.appId === 'string' &&
    (x.tenant === 'feishu' || x.tenant === 'lark') &&
    typeof x.profileName === 'string' &&
    (x.agentKind === 'claude' || x.agentKind === 'codex' || x.agentKind === 'pi') &&
    typeof x.configPath === 'string' &&
    typeof x.startedAt === 'string' &&
    typeof x.version === 'string'
  );
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the registry without pruning or rewriting it. */
export function readAndPrune(path: string = paths.processesFile): ProcessEntry[] {
  return readRaw(path).entries;
}

async function writeAtomic(entries: ProcessEntry[], path: string): Promise<void> {
  const body = `${JSON.stringify({ entries } satisfies RegistryFile, null, 2)}\n`;
  await writeFileAtomic(path, body, { mode: 0o600 });
}

function writeAtomicSync(entries: ProcessEntry[], path: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ entries } satisfies RegistryFile, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirSync(dirname(path));
}

/** Generate a short, human-typable id. Collisions are caller's problem;
 * acceptable since dead entries are pruned and same-machine fleets are
 * small. */
export function generateShortId(): string {
  return randomBytes(2).toString('hex');
}

export interface RegisterArgs {
  appId: string;
  tenant: TenantBrand;
  profileName?: string;
  agentKind?: AgentKind;
  configPath: string;
  version: string;
  registryFile?: string;
}

/**
 * Atomically prune + add this process to the registry. Returns the entry
 * representing this process (so callers can stash the id for later use, e.g.
 * "is /exit <id> me?" checks).
 *
 * Caller is responsible for installing cleanup that calls `unregister`.
 */
export async function register(args: RegisterArgs): Promise<ProcessEntry> {
  const registryFile = args.registryFile ?? paths.processesFile;
  const entry: ProcessEntry = {
    id: generateShortId(),
    pid: process.pid,
    appId: args.appId,
    tenant: args.tenant,
    profileName: args.profileName ?? 'claude',
    agentKind: args.agentKind ?? 'claude',
    configPath: args.configPath,
    startedAt: new Date().toISOString(),
    version: args.version,
  };
  await withRegistryFileLock(registryFile, async () => {
    const { entries: live } = await readForWriteState(registryFile);
    await writeAtomic([...live, entry], registryFile);
  });
  return entry;
}

/** Remove an entry by id. Atomic + prunes dead in same write. Async. */
export async function unregister(id: string, registryFile: string = paths.processesFile): Promise<void> {
  await withRegistryFileLock(registryFile, async () => {
    const { entries: live, pruned } = await readForWriteState(registryFile);
    const next = live.filter((e) => e.id !== id);
    if (next.length === live.length && !pruned) return;
    await writeAtomic(next, registryFile);
  });
}

/**
 * Replace mutable fields on the entry identified by `id`. Used after
 * /account change so `ps` reflects the current credentials. No-op when the
 * entry has already been pruned out.
 */
export async function updateEntry(
  id: string,
  patch: Partial<Pick<ProcessEntry, 'appId' | 'tenant' | 'configPath' | 'botName'>>,
  registryFile: string = paths.processesFile,
): Promise<void> {
  await withRegistryFileLock(registryFile, async () => {
    const { entries: live, pruned } = await readForWriteState(registryFile);
    let changed = false;
    const next = live.map((e) => {
      if (e.id !== id) return e;
      changed = true;
      return { ...e, ...patch };
    });
    if (!changed && !pruned) return;
    await writeAtomic(next, registryFile);
  });
}

/**
 * Synchronous unregister — for use inside `process.on('exit')` and other
 * sync-only contexts where async file I/O doesn't run. Best-effort.
 */
export function unregisterSync(id: string, registryFile: string = paths.processesFile): void {
  try {
    withRegistryFileLockSync(registryFile, () => {
      const live = readRaw(registryFile).entries;
      const next = live.filter((e) => e.id !== id);
      if (next.length === live.length) return;
      writeAtomicSync(next, registryFile);
    });
  } catch {
    // exit handlers must not throw.
  }
}

/** Best-effort: try to unlink any leftover tmp file we wrote. */
export function cleanupTmpFiles(registryFile: string = paths.processesFile): void {
  try {
    unlinkSync(`${registryFile}.tmp-${process.pid}`);
  } catch {
    /* ignore */
  }
}

/**
 * Find registry entries with the same appId, excluding `excludePid` (typically
 * the caller's own pid) so a process doesn't flag itself as a conflict.
 */
export function sameAppOthers(
  appId: string,
  excludePid = process.pid,
  registryFile: string = paths.processesFile,
): ProcessEntry[] {
  return readAndPrune(registryFile).filter((e) => e.appId === appId && e.pid !== excludePid);
}

export async function sameAppLiveOthers(
  appId: string,
  excludePid = process.pid,
  registryFile: string = paths.processesFile,
): Promise<ProcessEntry[]> {
  const candidates = sameAppOthers(appId, excludePid, registryFile);
  const checks = await Promise.all(
    candidates.map(async (entry) => ({
      entry,
      stale: await isEntryStale(entry, registryFile),
    })),
  );
  return checks.filter(({ stale }) => !stale).map(({ entry }) => entry);
}

/**
 * Resolve `target` (short id OR 1-based index in the current `ps` view) to
 * an entry. Index lookup uses the same read-only order as `readAndPrune()`.
 */
export function resolveTarget(target: string): ProcessEntry | undefined {
  const live = readAndPrune();
  const byId = live.find((e) => e.id === target);
  if (byId) return byId;
  const n = Number.parseInt(target, 10);
  if (Number.isFinite(n) && n >= 1 && n <= live.length) {
    return live[n - 1];
  }
  return undefined;
}

async function withRegistryFileLock<T>(registryFile: string, fn: () => Promise<T>): Promise<T> {
  await ensureRegistryFile(registryFile);
  const release = await lockfile.lock(registryFile, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function withRegistryFileLockSync<T>(registryFile: string, fn: () => T): T {
  ensureRegistryFileSync(registryFile);
  const release = lockfile.lockSync(registryFile, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
  });
  try {
    return fn();
  } finally {
    release();
  }
}

async function ensureRegistryFile(registryFile: string): Promise<void> {
  await mkdir(dirname(registryFile), { recursive: true });
  const legacy = legacyRegistryFile(registryFile);
  const initial = legacy ? (readRegistryFile(legacy) ?? EMPTY) : EMPTY;
  try {
    await writeFile(registryFile, `${JSON.stringify(initial, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function ensureRegistryFileSync(registryFile: string): void {
  mkdirSync(dirname(registryFile), { recursive: true });
  const legacy = legacyRegistryFile(registryFile);
  const initial = legacy ? (readRegistryFile(legacy) ?? EMPTY) : EMPTY;
  try {
    writeFileSync(registryFile, `${JSON.stringify(initial, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

async function readForWriteState(
  registryFile: string,
): Promise<{ entries: ProcessEntry[]; pruned: boolean }> {
  const raw = readRaw(registryFile);
  const checks = await Promise.all(
    raw.entries.map(async (entry) => ({
      entry,
      stale: await isEntryStale(entry, registryFile),
    })),
  );
  const entries = checks.filter(({ stale }) => !stale).map(({ entry }) => entry);
  return { entries, pruned: entries.length !== raw.entries.length };
}

async function isEntryStale(entry: ProcessEntry, registryFile: string): Promise<boolean> {
  const rootDir = rootDirFromRegistryFile(registryFile);
  const appPaths = resolveAppPaths({ rootDir, profile: entry.profileName });
  const [profileLock, appLock] = await Promise.all([
    checkRuntimeLock(appPaths.profileLockFile),
    checkRuntimeLock(appPaths.appLockFile(entry.appId)),
  ]);
  return !lockMatchesEntry(profileLock, entry, 'profile') || !lockMatchesEntry(appLock, entry, 'app');
}

function lockMatchesEntry(
  lock: Awaited<ReturnType<typeof checkRuntimeLock>>,
  entry: ProcessEntry,
  kind: 'profile' | 'app',
): boolean {
  if (lock.uncertain) {
    throw new Error(
      `runtime lock state unknown for ${kind} ${entry.profileName}/${entry.appId}: ${lock.error ?? 'unknown'}`,
    );
  }
  if (!lock.locked || !lock.meta) return false;
  if (lock.meta.kind !== kind) return false;
  if (lock.meta.profile !== entry.profileName) return false;
  if (lock.meta.agentKind !== entry.agentKind) return false;
  if (lock.meta.pid !== entry.pid) return false;
  if (kind === 'app' && lock.meta.appId !== entry.appId) return false;
  return true;
}

function rootDirFromRegistryFile(registryFile: string): string {
  const parent = dirname(registryFile);
  return basename(parent) === 'registry' ? dirname(parent) : parent;
}

function readRaw(path: string): RegistryFile {
  const preferred = readRegistryFile(path);
  if (preferred) return preferred;
  const legacy = legacyRegistryFile(path);
  if (legacy && legacy !== path) {
    return readRegistryFile(legacy) ?? { entries: [] };
  }
  return { entries: [] };
}

function readRegistryFile(path: string): RegistryFile | undefined {
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<RegistryFile>;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isValidEntry) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { entries: [] };
  }
}

function legacyRegistryFile(path: string): string | undefined {
  if (basename(path) !== 'processes.json') return undefined;
  const parent = dirname(path);
  if (basename(parent) !== 'registry') return undefined;
  const legacy = join(dirname(parent), 'processes.json');
  return existsSync(path) ? undefined : legacy;
}

function fsyncDirSync(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}
