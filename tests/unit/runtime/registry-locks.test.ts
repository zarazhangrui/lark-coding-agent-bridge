import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  readRuntimeLockMeta,
  runtimeLockMetaFile,
  withProfileAndAppLocks,
} from '../../../src/runtime/locks';
import {
  readAndPrune,
  register,
  sameAppLiveOthers,
  unregisterSync,
  type ProcessEntry,
} from '../../../src/runtime/registry';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-registry-locks-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('registry and runtime lock integration', () => {
  it('keeps read paths read-only while write paths prune stale lock entries', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [
        entry({ id: 'stale-a', pid: 999_999_991, profileName: 'claude', appId: 'cli_old' }),
        entry({ id: 'stale-b', pid: process.pid, profileName: 'codex-dev', appId: 'cli_other' }),
      ],
    });
    const before = await readFile(registryFile, 'utf8');

    expect(readAndPrune(registryFile).map((item) => item.id)).toEqual(['stale-a', 'stale-b']);
    expect(await readFile(registryFile, 'utf8')).toBe(before);

    const registered = await register({
      appId: 'cli_new',
      tenant: 'feishu',
      profileName: 'codex-dev',
      agentKind: 'codex',
      configPath: join(root, 'config.json'),
      version: '0.1.32',
      registryFile,
    });

    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
    expect(persisted.entries.map((item) => item.id)).toEqual([registered.id]);
    expect(persisted.entries[0]).toMatchObject({
      appId: 'cli_new',
      profileName: 'codex-dev',
      agentKind: 'codex',
      pid: process.pid,
    });
  });

  it('keeps pi process entries when reading the registry', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [entry({ id: 'pi-live', profileName: 'pi-dev', agentKind: 'pi' })],
    });

    expect(readAndPrune(registryFile).map((item) => item.id)).toEqual(['pi-live']);
  });

  it('reads pi runtime lock metadata', async () => {
    const root = await makeRoot();
    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'pi-dev' });

    await withProfileAndAppLocks(lockedPaths, 'cli_pi', 'pi', async () => {
      await expect(readRuntimeLockMeta(lockedPaths.profileLockFile)).resolves.toMatchObject({
        profile: 'pi-dev',
        agentKind: 'pi',
        pid: process.pid,
      });
    });
  });

  it('uses active profile/app locks instead of PID liveness when pruning writes', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const lockedEntry = entry({
      id: 'locked',
      pid: process.pid,
      profileName: 'claude',
      appId: 'cli_existing',
      agentKind: 'claude',
    });
    await writeJson(registryFile, { entries: [lockedEntry] });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await withProfileAndAppLocks(lockedPaths, 'cli_existing', 'claude', async () => {
      const registered = await register({
        appId: 'cli_new',
        tenant: 'feishu',
        profileName: 'codex-dev',
        agentKind: 'codex',
        configPath: join(root, 'config.json'),
        version: '0.1.32',
        registryFile,
      });

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
      expect(persisted.entries.map((item) => item.id)).toEqual(['locked', registered.id]);
    });
  });

  it('does not keep stale entries just because a new holder owns the same app lock', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [
        entry({
          id: 'stale-same-app',
          pid: 999_999_992,
          profileName: 'claude',
          appId: 'cli_existing',
          agentKind: 'claude',
        }),
      ],
    });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await withProfileAndAppLocks(lockedPaths, 'cli_existing', 'claude', async () => {
      const registered = await register({
        appId: 'cli_new',
        tenant: 'feishu',
        profileName: 'codex-dev',
        agentKind: 'codex',
        configPath: join(root, 'config.json'),
        version: '0.1.32',
        registryFile,
      });

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
      expect(persisted.entries.map((item) => item.id)).toEqual([registered.id]);
    });
  });

  it('filters stale same-app conflicts using runtime lock metadata', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [
        entry({
          id: 'stale-same-app',
          pid: 999_999_992,
          profileName: 'claude',
          appId: 'cli_existing',
          agentKind: 'claude',
        }),
      ],
    });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await withProfileAndAppLocks(lockedPaths, 'cli_existing', 'claude', async () => {
      await expect(sameAppLiveOthers('cli_existing', process.pid, registryFile)).resolves.toEqual([]);
    });
  });

  it('reads legacy root processes.json but writes only the registry directory', async () => {
    const root = await makeRoot();
    const legacyRegistryFile = join(root, 'processes.json');
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(legacyRegistryFile, {
      entries: [entry({ id: 'legacy', pid: 999_999_993, profileName: 'claude' })],
    });
    const legacyBefore = await readFile(legacyRegistryFile, 'utf8');

    expect(readAndPrune(registryFile).map((item) => item.id)).toEqual(['legacy']);

    const registered = await register({
      appId: 'cli_new',
      tenant: 'feishu',
      profileName: 'codex-dev',
      agentKind: 'codex',
      configPath: join(root, 'config.json'),
      version: '0.1.32',
      registryFile,
    });

    expect(await readFile(legacyRegistryFile, 'utf8')).toBe(legacyBefore);
    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
    expect(persisted.entries.map((item) => item.id)).toEqual([registered.id]);
  });

  it('keeps registry locking realpath-safe and separate from PID probing', async () => {
    const [registrySource, lockSource] = await Promise.all([
      readFile(join(process.cwd(), 'src/runtime/registry.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/runtime/locks.ts'), 'utf8'),
    ]);

    expect(registrySource).toMatch(/lockfile\.lock\(registryFile,[\s\S]*realpath:\s*false/);
    expect(registrySource).toMatch(/lockfile\.lockSync\(registryFile,[\s\S]*realpath:\s*false/);
    expect(lockSource).toMatch(/lockfile\.check\(target,[\s\S]*realpath:\s*false/);
  });

  it('fails closed instead of pruning when live lock metadata is unreadable', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const lockedEntry = entry({
      id: 'locked',
      pid: process.pid,
      profileName: 'claude',
      appId: 'cli_existing',
      agentKind: 'claude',
    });
    await writeJson(registryFile, { entries: [lockedEntry] });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await withProfileAndAppLocks(lockedPaths, 'cli_existing', 'claude', async () => {
      await writeFile(runtimeLockMetaFile(lockedPaths.profileLockFile), 'not json', 'utf8');

      await expect(
        register({
          appId: 'cli_new',
          tenant: 'feishu',
          profileName: 'codex-dev',
          agentKind: 'codex',
          configPath: join(root, 'config.json'),
          version: '0.1.32',
          registryFile,
        }),
      ).rejects.toThrow(/runtime lock state unknown/);

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
      expect(persisted.entries.map((item) => item.id)).toEqual(['locked']);
    });
  });

  it('uses the registry file lock from sync unregister paths', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, { entries: [entry({ id: 'remove-me' })] });

    unregisterSync('remove-me', registryFile);

    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] };
    expect(persisted.entries).toEqual([]);
  });
});

function entry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    profileName: 'claude',
    agentKind: 'claude',
    ...overrides,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
