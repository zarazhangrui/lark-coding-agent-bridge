import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileCreate } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig } from '../../../src/config/profile-store';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Claude Regression' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile create command', () => {
  it('creates a named profile from existing app credentials in an initialized root', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'codex-dev', ['codex-dev']);

    await runProfileCreate('claude-regression', {
      rootDir: root,
      agent: 'claude',
      workspace,
      appId: 'cli_claude_regression',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as RootConfig;
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude-regression' });
    const secret = await getSecret(secretKeyForApp('cli_claude_regression'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_claude_regression',
      'manual-secret',
      'feishu',
    );
    expect(saved.activeProfile).toBe('codex-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('codex-dev\n');
    expect(saved.profiles['codex-dev']?.agentKind).toBe('codex');
    expect(saved.profiles['claude-regression']?.agentKind).toBe('claude');
    expect(saved.profiles['claude-regression']?.workspaces.default).toBe(workspaceRealpath);
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('creates a named Codex profile that can write inside the default workspace by default', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'claude', ['claude']);
    const codex = await writeVersionExecutable(root, 'codex', 'codex 1.2.3');
    const oldCodexBin = process.env.LARK_CHANNEL_CODEX_BIN;
    process.env.LARK_CHANNEL_CODEX_BIN = codex;

    try {
      await runProfileCreate('codex-dev', {
        rootDir: root,
        agent: 'codex',
        workspace,
        appId: 'cli_codex_dev',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    } finally {
      if (oldCodexBin === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodexBin;
      }
    }

    const configPath = join(root, 'config.json');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles['codex-dev']?.agentKind).toBe('codex');
    expect(saved.profiles['codex-dev']).not.toHaveProperty('sandbox');

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles['codex-dev']?.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('requires explicit app credentials or reuse when adding a profile non-interactively', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);

    await expect(
      runProfileCreate('agy', {
        rootDir: root,
        agent: 'agy',
      }),
    ).rejects.toThrow(/非交互模式无法完成扫码创建应用|pass --app-id/);
  });

  it('creates a named agy profile by explicitly reusing the active app credentials', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'claude', ['claude']);
    const agy = await writeVersionExecutable(root, 'agy', 'agy 1.0.8');
    const oldAgyBin = process.env.LARK_CHANNEL_ANTIGRAVITY_BIN;
    const oldAppSecret = process.env.APP_SECRET;
    process.env.LARK_CHANNEL_ANTIGRAVITY_BIN = agy;
    process.env.APP_SECRET = 'reused-secret';

    try {
      await runProfileCreate('agy', {
        rootDir: root,
        agent: 'agy',
        workspace,
        reuseActiveApp: true,
      });
    } finally {
      if (oldAgyBin === undefined) {
        delete process.env.LARK_CHANNEL_ANTIGRAVITY_BIN;
      } else {
        process.env.LARK_CHANNEL_ANTIGRAVITY_BIN = oldAgyBin;
      }
      if (oldAppSecret === undefined) {
        delete process.env.APP_SECRET;
      } else {
        process.env.APP_SECRET = oldAppSecret;
      }
    }

    const configPath = join(root, 'config.json');
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as RootConfig;
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'agy' });
    const secret = await getSecret(secretKeyForApp('cli_claude'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).not.toHaveBeenCalled();
    expect(saved.activeProfile).toBe('claude');
    expect(saved.profiles.agy?.agentKind).toBe('antigravity');
    expect(saved.profiles.agy?.antigravity?.binaryPath).toBe(agy);
    expect(saved.profiles.agy?.workspaces.default).toBe(workspaceRealpath);
    expect(secret).toBe('reused-secret');
  });

  it('refuses to overwrite an existing profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);

    await expect(
      runProfileCreate('claude', {
        rootDir: root,
        agent: 'claude',
        appId: 'cli_other',
        appSecret: 'manual-secret',
      }),
    ).rejects.toThrow(/profile already exists/);
  });

  it('explains how to recover when an existing profile has the wrong agent', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex', ['codex']);
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    saved.profiles.codex = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_codex',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
    });
    await writeFile(join(root, 'config.json'), `${JSON.stringify(saved, null, 2)}\n`, 'utf8');

    let error: Error | undefined;
    try {
      await runProfileCreate('codex', {
        rootDir: root,
        agent: 'codex',
        appId: 'cli_codex_new',
        appSecret: 'manual-secret',
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      error = err;
    }

    expect(error).toBeDefined();
    const message = error?.message ?? '';
    expect(message).toContain('profile codex already exists with agentKind claude');
    expect(message).toContain('profile create requested --agent codex');
    expect(message).toContain('Profile names are labels');
    expect(message).toContain('choose another name');
    expect(message).toContain('remove profile codex');
  });

  it('creates a named profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['codex-dev']);

    await runProfileCreate('claude-managed', {
      rootDir: root,
      agent: 'claude',
      appId: 'cli_claude_managed',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'claude-managed' }).defaultWorkspaceDir);
    expect(saved.profiles['claude-managed']?.workspaces.default).toBe(managed);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-create-'));
  roots.push(root);
  return root;
}

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    const agentKind: AgentKind = name.startsWith('codex') ? 'codex' : 'claude';
    profiles[name] = createDefaultProfileConfig({
      agentKind,
      accounts: {
        app: {
          id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    preferences: {},
    profiles,
  };
  await writeJson(join(root, 'config.json'), config);
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`, 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
