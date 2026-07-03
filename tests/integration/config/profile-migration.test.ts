import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrate } from '../../../src/cli/commands/migrate';
import {
  ActiveBridgeMigrationConflictError,
  migrateV1ToV2,
  type ActiveBridgeMigrationProcess,
} from '../../../src/config/migrate-v2';
import type { RootConfig } from '../../../src/config/profile-schema';
import { resolveProfileRuntime } from '../../../src/runtime/profile-runtime';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];
const childProcesses: ChildProcess[] = [];

async function makeRoot(): Promise<string> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(tmpdir(), 'bridge-profile-migration-')),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(childProcesses.splice(0).map(killChild));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile v2 migration', () => {
  it('backs up root config, migrates access, and moves runtime state into the claude profile', async () => {
    const root = await makeRoot();
    const legacyConfig = {
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: join(root, 'secrets-getter'),
            args: [],
          },
        },
      },
      preferences: {
        messageReply: 'card',
        requireMentionInGroup: false,
        access: {
          allowedUsers: ['ou_allowed'],
          allowedChats: ['oc_allowed'],
          admins: ['ou_admin'],
        },
      },
    };
    await writeJson(join(root, 'config.json'), legacyConfig);
    await writeJson(join(root, 'sessions.json'), {
      chat_a: { sessionId: 's1', cwd: homedir(), updatedAt: 1 },
    });
    await writeJson(join(root, 'workspaces.json'), {
      chats: { chat_a: { cwd: homedir() } },
      named: {},
    });
    await writeFile(join(root, 'secrets.enc'), '{"entries":{}}\n');
    await mkdir(join(root, 'media'), { recursive: true });
    await writeFile(join(root, 'media', 'file.bin'), 'media');
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'today.log'), 'log');

    const result = await migrateV1ToV2({ rootDir: root, profile: 'claude' });

    expect(result).toEqual({ migrated: true, profile: 'claude' });
    expect(await readJson(join(root, 'config.json.bak'))).toEqual(legacyConfig);

    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.schemaVersion).toBe(2);
    expect(next.activeProfile).toBe('claude');
    expect(next.secrets).toEqual(legacyConfig.secrets);
    expect(next.profiles.claude?.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(next.profiles.claude?.preferences).toEqual({ messageReply: 'card' });
    expect(next.profiles.claude?.workspaces).toEqual({});
    expect(next.profiles.claude?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(next.profiles.claude).not.toHaveProperty('sandbox');

    const profileDir = join(root, 'profiles', 'claude');
    await expect(stat(join(profileDir, 'sessions.json'))).resolves.toBeDefined();
    await expect(stat(join(profileDir, 'workspaces.json'))).resolves.toBeDefined();
    await expect(stat(join(profileDir, 'secrets.enc'))).resolves.toBeDefined();
    await expect(stat(join(profileDir, 'media', 'file.bin'))).resolves.toBeDefined();
    await expect(stat(join(profileDir, 'logs', 'today.log'))).resolves.toBeDefined();
    await expect(stat(join(root, 'sessions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'workspaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports active bridge processes as a structured migration conflict', async () => {
    const root = await makeRoot();
    const legacyConfig = {
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
    };
    await writeJson(join(root, 'config.json'), legacyConfig);
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'self',
          pid: spawnLiveProcess(),
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });

    await expect(migrateV1ToV2({ rootDir: root, profile: 'claude' })).rejects.toMatchObject({
      name: 'ActiveBridgeMigrationConflictError',
      processes: [
        expect.objectContaining({
          id: 'self',
          pid: expect.any(Number),
          appId: 'cli_test',
        }),
      ],
    });
    expect(await readJson(join(root, 'config.json'))).toEqual(legacyConfig);
    await expect(stat(join(root, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops active bridge processes and retries the migrate command after confirmation', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'self',
          pid: spawnLiveProcess(),
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });
    const stopped: ActiveBridgeMigrationProcess[][] = [];

    await runMigrate({
      config: join(root, 'config.json'),
      profile: 'claude',
      confirmStopActiveBridgeProcesses: async () => true,
      stopActiveBridgeProcesses: async (processes) => {
        stopped.push(processes);
        await writeJson(join(root, 'processes.json'), { entries: [] });
      },
    });

    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toEqual([
      expect.objectContaining({
        id: 'self',
        pid: expect.any(Number),
        appId: 'cli_test',
      }),
    ]);
    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.schemaVersion).toBe(2);
    expect(next.activeProfile).toBe('claude');
  });

  it('upgrades a legacy config by stopping the active old-version process after confirmation', async () => {
    const root = await makeRoot();
    const pid = spawnLiveProcess();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'old-version',
          pid,
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });

    await runMigrate({
      config: join(root, 'config.json'),
      profile: 'claude',
      confirmStopActiveBridgeProcesses: async () => true,
    });

    expect(isProcessAlive(pid)).toBe(false);
    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.schemaVersion).toBe(2);
    expect(next.activeProfile).toBe('claude');
    await expect(stat(join(root, 'config.json.bak'))).resolves.toBeDefined();
  });

  it('ignores registry entries that point at the current migrate process', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'stale-reused-pid',
          pid: process.pid,
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });

    const result = await migrateV1ToV2({ rootDir: root, profile: 'claude' });

    expect(result).toEqual({ migrated: true, profile: 'claude' });
    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.schemaVersion).toBe(2);
  });

  it('keeps repeated migration on an existing v2 config as a no-op even with active registry entries', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await runMigrate({
      config: join(root, 'config.json'),
      profile: 'claude',
      confirmStopActiveBridgeProcesses: async () => true,
    });
    const first = (await readJson(join(root, 'config.json'))) as RootConfig;
    const activePid = spawnLiveProcess();
    await writeJson(join(root, 'registry', 'processes.json'), {
      entries: [
        {
          id: 'already-v2',
          pid: activePid,
          appId: 'cli_test',
          tenant: 'feishu',
          profileName: 'claude',
          agentKind: 'claude',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.2.2',
        },
      ],
    });

    await runMigrate({
      config: join(root, 'config.json'),
      profile: 'claude',
      confirmStopActiveBridgeProcesses: async () => {
        throw new Error('repeat migration should not ask to stop active v2 processes');
      },
      stopActiveBridgeProcesses: async () => {
        throw new Error('repeat migration should not stop active v2 processes');
      },
    });

    expect(isProcessAlive(activePid)).toBe(true);
    expect(await readJson(join(root, 'config.json'))).toEqual(first);
  });

  it('keeps legacy config unchanged when the user declines stopping active bridges', async () => {
    const root = await makeRoot();
    const legacyConfig = legacyConfigFixture();
    await writeJson(join(root, 'config.json'), legacyConfig);
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'self',
          pid: spawnLiveProcess(),
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });

    await runMigrate({
      config: join(root, 'config.json'),
      profile: 'claude',
      confirmStopActiveBridgeProcesses: async () => false,
      stopActiveBridgeProcesses: async () => {
        throw new Error('stop should not be called');
      },
    });

    expect(await readJson(join(root, 'config.json'))).toEqual(legacyConfig);
    await expect(stat(join(root, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets runtime bootstrap callers handle active bridge conflicts and retry automatic migration', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'self',
          pid: spawnLiveProcess(),
          appId: 'cli_test',
          tenant: 'feishu',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.1.32',
        },
      ],
    });
    const handled: ActiveBridgeMigrationProcess[][] = [];

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'claude',
      allowBootstrap: false,
      handleActiveBridgeMigrationConflict: async (err) => {
        handled.push(err.processes);
        await writeJson(join(root, 'processes.json'), { entries: [] });
        return true;
      },
    });

    expect(handled).toHaveLength(1);
    expect(runtime.profile).toBe('claude');
    expect(runtime.profileConfig.accounts.app.id).toBe('cli_test');
    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.schemaVersion).toBe(2);
  });

  it('imports a concrete legacy workspace as the default working directory', async () => {
    const root = await makeRoot();
    const concrete = join(root, 'customer-project');
    await mkdir(concrete, { recursive: true });
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'workspaces.json'), {
      chats: { chat_a: { cwd: concrete } },
      named: { main: concrete },
    });

    await migrateV1ToV2({ rootDir: root, profile: 'claude' });

    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    const concreteRealpath = await realpath(concrete);
    expect(next.profiles.claude?.workspaces.default).toBe(concreteRealpath);
  });

  it('does not import broad legacy workspaces', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'workspaces.json'), {
      chats: { chat_home: { cwd: homedir() } },
      named: { home: homedir() },
    });

    await migrateV1ToV2({ rootDir: root, profile: 'claude' });

    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.profiles.claude?.workspaces.default).toBeUndefined();
  });

  it('migrates a legacy config to Codex through the migrate command', async () => {
    const root = await makeRoot();
    const codex = await writeVersionExecutable(root, 'codex', 'codex 1.2.3');
    const oldCodexBin = process.env.LARK_CHANNEL_CODEX_BIN;
    process.env.LARK_CHANNEL_CODEX_BIN = codex;
    await writeJson(join(root, 'config.json'), legacyConfigFixture());

    try {
      await runMigrate({
        config: join(root, 'config.json'),
        profile: 'codex',
        agent: 'codex',
      });
    } finally {
      if (oldCodexBin === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodexBin;
      }
    }

    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.activeProfile).toBe('codex');
    expect(next.profiles.codex?.agentKind).toBe('codex');
    expect(next.profiles.codex?.codex).toMatchObject({
      binaryPath: codex,
    });
    expect(next.profiles.codex?.codex?.realpath).toBeUndefined();
    expect(next.profiles.codex?.codex?.version).toBeUndefined();
    expect(next.profiles.codex?.codex?.sha256).toBeUndefined();
    expect(next.profiles.codex?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(next.profiles.codex).not.toHaveProperty('sandbox');
  });

  it('carries pi config through migrateV1ToV2', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());

    const result = await migrateV1ToV2({
      rootDir: root,
      profile: 'pi',
      agentKind: 'pi',
      pi: { binaryPath: '/x/pi' },
    });

    expect(result).toEqual({ migrated: true, profile: 'pi' });
    const next = (await readJson(join(root, 'config.json'))) as RootConfig;
    expect(next.profiles.pi?.agentKind).toBe('pi');
    expect(next.profiles.pi?.pi).toMatchObject({ binaryPath: '/x/pi' });
  });

  it('keeps agentKind: pi on active bridge process entries during migration conflicts', async () => {
    const root = await makeRoot();
    await writeJson(join(root, 'config.json'), legacyConfigFixture());
    await writeJson(join(root, 'processes.json'), {
      entries: [
        {
          id: 'self',
          pid: spawnLiveProcess(),
          appId: 'cli_test',
          tenant: 'feishu',
          profileName: 'pi',
          agentKind: 'pi',
          configPath: join(root, 'config.json'),
          startedAt: new Date().toISOString(),
          version: '0.2.2',
        },
      ],
    });

    await expect(migrateV1ToV2({ rootDir: root, profile: 'pi' })).rejects.toMatchObject({
      name: 'ActiveBridgeMigrationConflictError',
      processes: [
        expect.objectContaining({
          id: 'self',
          agentKind: 'pi',
        }),
      ],
    });
  });
});

function legacyConfigFixture(): unknown {
  return {
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnLiveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  childProcesses.push(child);
  if (!child.pid) throw new Error('failed to spawn live process');
  return child.pid;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 500);
  });
}
