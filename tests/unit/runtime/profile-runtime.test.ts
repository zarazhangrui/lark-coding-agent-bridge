import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { legacyLarkCliSourceOverlayPaths } from '../../../src/lark-cli/legacy-source-overlay';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const wizard = vi.hoisted(() => ({
  next: {
    accounts: {
      app: {
        id: 'cli_wizard',
        secret: 'wizard-secret',
        tenant: 'feishu' as const,
      },
    },
    preferences: {},
  },
}));

const auth = vi.hoisted(() => {
  type ValidationMockResult = { ok: boolean; botName?: string; reason?: string };
  return {
    validateAppCredentials: vi.fn(
      async (): Promise<ValidationMockResult> => ({ ok: true, botName: 'Bridge Bot' }),
    ),
  };
});

vi.mock('../../../src/bot/wizard', () => ({
  runRegistrationWizard: vi.fn(async () => wizard.next),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile runtime resolver', () => {
  it('recovers a crashed legacy lark-cli source overlay before loading the root config', async () => {
    const root = await tmpRoot();
    const configFile = join(root, 'config.json');
    const { backupFile, markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
    const original = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: createDefaultProfileConfig({
          agentKind: 'codex',
          accounts: { app },
          codex: { binaryPath: 'codex' },
        }),
      },
    }, null, 2)}\n`;
    const overlay = `${JSON.stringify({ accounts: { app: { id: 'cli_overlay' } } }, null, 2)}\n`;
    await writeFile(backupFile, original, { mode: 0o600 });
    await writeFile(markerFile, `${JSON.stringify({ hadConfig: true, profile: 'codex' })}\n`, {
      mode: 0o600,
    });
    await writeFile(configFile, overlay, { mode: 0o600 });

    const runtime = await resolveProfileRuntime({
      config: configFile,
      profile: 'codex',
      allowBootstrap: false,
    });

    expect(runtime.profile).toBe('codex');
    const recovered = JSON.parse(await readFile(configFile, 'utf8')) as {
      schemaVersion?: number;
      profiles?: Record<string, unknown>;
      accounts?: unknown;
    };
    expect(recovered.schemaVersion).toBe(2);
    expect(recovered.profiles?.codex).toBeTruthy();
    expect(recovered.accounts).toBeUndefined();
    await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bootstraps first-run profile from existing app credentials without QR registration', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      workspace,
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      activeProfile: string;
      profiles: Record<string, { accounts: { app: { id: string; secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const secret = await getSecret(secretKeyForApp('cli_existing'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_existing',
      'manual-secret',
      'feishu',
    );
    expect(runtime.profile).toBe('claude');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('claude');
    expect(saved.profiles.claude?.accounts.app.id).toBe('cli_existing');
    expect(saved.profiles.claude?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_existing',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('rejects existing app bootstrap without writing config when credentials are invalid', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    auth.validateAppCredentials.mockResolvedValueOnce({ ok: false, reason: 'code=999' });

    await expect(
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        agent: 'claude',
        workspace,
        allowBootstrap: true,
        appId: 'cli_bad',
        appSecret: 'bad-secret',
        tenant: 'feishu',
      } as Parameters<typeof resolveProfileRuntime>[0] & {
        appId: string;
        appSecret: string;
        tenant: 'feishu';
      }),
    ).rejects.toThrow(/code=999/);
    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly instead of opening the QR wizard during non-interactive first run', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'claude',
          allowBootstrap: true,
        }),
      ).rejects.toThrow(/非交互模式无法完成扫码创建应用/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly when non-interactive existing-app bootstrap omits the app secret', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'claude',
          allowBootstrap: true,
          appId: 'cli_missing_secret',
          tenant: 'feishu',
        }),
      ).rejects.toThrow(/非交互模式缺少 App Secret/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bootstraps a managed default workspace when no workspace is provided', async () => {
    const root = await tmpRoot();

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'claude' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.claude?.workspaces?.default).toBe(managed);
  });

  it('reports detected local agents when first-run agent selection is ambiguous', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const claude = await writeExecutable(bin, 'claude');
    const codex = await writeExecutable(bin, 'codex');
    const pi = await writeExecutable(bin, 'pi');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    const oldPi = process.env.LARK_CHANNEL_PI_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_CLAUDE_BIN;
    delete process.env.LARK_CHANNEL_CODEX_BIN;
    delete process.env.LARK_CHANNEL_PI_BIN;

    try {
      let error: Error | undefined;
      try {
        await resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
          selectAgent: () => undefined,
        });
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        error = err;
      }

      expect(error).toBeDefined();
      const message = error?.message ?? '';
      expect(message).toContain('检测到多个本地 agent');
      expect(message).toContain('claude');
      expect(message).toContain(claude);
      expect(message).toContain('codex');
      expect(message).toContain(codex);
      expect(message).toContain('pi');
      expect(message).toContain(pi);
      expect(message).toContain('--agent <claude|codex|pi>');
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
      if (oldPi === undefined) {
        delete process.env.LARK_CHANNEL_PI_BIN;
      } else {
        process.env.LARK_CHANNEL_PI_BIN = oldPi;
      }
    }
  });

  it('continues first-run bootstrap with the selected local agent when multiple are detected', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const codex = await writeExecutable(bin, 'codex');
    await writeExecutable(bin, 'claude');
    await writeExecutable(bin, 'pi');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    const oldPi = process.env.LARK_CHANNEL_PI_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_CLAUDE_BIN;
    delete process.env.LARK_CHANNEL_CODEX_BIN;
    delete process.env.LARK_CHANNEL_PI_BIN;

    try {
      const runtime = await withTty(true, true, () =>
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
          selectAgent: (detected) => {
            expect(detected.map((agent) => agent.kind)).toEqual(['claude', 'codex', 'pi']);
            return 'codex';
          },
        }),
      );

      expect(runtime.profile).toBe('codex');
      expect(runtime.profileConfig.agentKind).toBe('codex');
      expect(runtime.profileConfig.codex?.binaryPath).toBe(codex);
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
      if (oldPi === undefined) {
        delete process.env.LARK_CHANNEL_PI_BIN;
      } else {
        process.env.LARK_CHANNEL_PI_BIN = oldPi;
      }
    }
  });

  it('continues first-run bootstrap with pi selected when multiple agents are detected', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    await writeExecutable(bin, 'codex');
    await writeExecutable(bin, 'claude');
    const pi = await writeExecutable(bin, 'pi');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    const oldPi = process.env.LARK_CHANNEL_PI_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_CLAUDE_BIN;
    delete process.env.LARK_CHANNEL_CODEX_BIN;
    delete process.env.LARK_CHANNEL_PI_BIN;

    try {
      const runtime = await withTty(true, true, () =>
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
          selectAgent: (detected) => {
            expect(detected.map((agent) => agent.kind)).toEqual(['claude', 'codex', 'pi']);
            return 'pi';
          },
        }),
      );

      expect(runtime.profile).toBe('pi');
      expect(runtime.profileConfig.agentKind).toBe('pi');
      expect(runtime.profileConfig.pi?.binaryPath).toBe(pi);
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
      if (oldPi === undefined) {
        delete process.env.LARK_CHANNEL_PI_BIN;
      } else {
        process.env.LARK_CHANNEL_PI_BIN = oldPi;
      }
    }
  });

  it('adds a managed default workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      allowBootstrap: true,
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'claude' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.claude?.workspaces?.default).toBe(managed);
  });

  it('uses a requested workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      workspace,
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('migrates an origin-main v1 config to canonical profile permissions without stored sandbox', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {
          messageReply: 'card',
          showToolCalls: false,
          maxConcurrentRuns: 3,
          requireMentionInGroup: false,
          access: {
            allowedUsers: ['ou_allowed'],
            allowedChats: ['oc_allowed'],
            admins: ['ou_admin'],
          },
        },
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'claude',
      workspace,
      allowBootstrap: false,
    });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        access?: unknown;
        preferences?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(runtime.profileConfig.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(runtime.profileConfig.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.profiles.claude?.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(saved.profiles.claude?.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
  });

  it('uses the requested agent when migrating a legacy config into an explicit profile', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const codex = await writeExecutable(bin, 'codex');
    const oldPath = process.env.PATH;
    const oldHome = process.env.LARK_CHANNEL_HOME;
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`;
    process.env.LARK_CHANNEL_HOME = root;
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    try {
      const runtime = await resolveProfileRuntime({
        profile: 'codex',
        agent: 'codex',
        allowBootstrap: true,
      });
      const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
        profiles: Record<string, { agentKind: string; codex?: { binaryPath?: string } }>;
      };

      expect(runtime.profile).toBe('codex');
      expect(runtime.profileConfig.agentKind).toBe('codex');
      expect(runtime.profileConfig.codex?.binaryPath).toBe(codex);
      expect(saved.profiles.codex?.agentKind).toBe('codex');
      expect(saved.profiles.codex?.codex?.binaryPath).toBe(codex);
    } finally {
      process.env.PATH = oldPath;
      if (oldHome === undefined) {
        delete process.env.LARK_CHANNEL_HOME;
      } else {
        process.env.LARK_CHANNEL_HOME = oldHome;
      }
    }
  });

  it('runs the same v2 migration for explicit config paths', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const codex = await writeExecutable(bin, 'codex');
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`;
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'sessions.json'),
      `${JSON.stringify({ chat_a: { threadId: 'thread-1' } }, null, 2)}\n`,
    );

    try {
      const runtime = await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'codex',
        agent: 'codex',
        allowBootstrap: true,
      });

      expect(runtime.profileConfig.agentKind).toBe('codex');
      expect(runtime.profileConfig.codex).toMatchObject({
        binaryPath: codex,
      });
      expect(runtime.profileConfig.codex?.realpath).toBeUndefined();
      expect(runtime.profileConfig.codex?.version).toBeUndefined();
      expect(runtime.profileConfig.codex?.sha256).toBeUndefined();
      await expect(readFile(join(root, 'profiles', 'codex', 'sessions.json'), 'utf8')).resolves
        .toContain('thread-1');
      await expect(readFile(join(root, 'sessions.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('imports a valid legacy workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'legacy-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'workspaces.json'),
      `${JSON.stringify({
        chats: { chat_a: { cwd: workspace } },
        named: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('resolves the active Codex profile from a v2 root config', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex-dev', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profile).toBe('codex-dev');
    expect(runtime.profileConfig.agentKind).toBe('codex');
    expect(runtime.appPaths.profileDir).toBe(join(root, 'profiles', 'codex-dev'));
  });

  it('canonicalizes legacy Codex sandbox while fixing old Codex runtime defaults', async () => {
    const root = await tmpRoot();
    const legacyCodex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: { binaryPath: '/usr/local/bin/codex' },
    }) as unknown as Record<string, unknown>;
    legacyCodex.sandbox = {
      default: 'read-only',
      max: 'read-only',
      defaultMode: 'read-only',
      maxMode: 'read-only',
    };
    delete legacyCodex.permissions;
    delete legacyCodex.permissionSource;
    (legacyCodex.codex as { inheritCodexHome?: boolean }).inheritCodexHome = false;
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': legacyCodex,
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
        codex?: { inheritCodexHome?: boolean; ignoreUserConfig?: boolean };
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'read-only',
    });
    expect(runtime.profileConfig.codex?.inheritCodexHome).toBe(true);
    expect(runtime.profileConfig.codex?.ignoreUserConfig).toBe(false);
    expect(saved.profiles['codex-dev']?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles['codex-dev']).not.toHaveProperty('sandbox');
    expect(saved.profiles['codex-dev']).not.toHaveProperty('permissionSource');
    expect(saved.profiles['codex-dev']?.codex?.inheritCodexHome).toBe(true);
    expect(saved.profiles['codex-dev']?.codex?.ignoreUserConfig).toBe(false);
  });

  it('upgrades legacy Claude workspace sandbox default to full access', async () => {
    const root = await tmpRoot();
    const legacyClaude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    }) as unknown as Record<string, unknown>;
    legacyClaude.sandbox = {
      default: 'workspace-write',
      max: 'workspace-write',
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    };
    delete legacyClaude.permissions;
    delete legacyClaude.permissionSource;
    await writeProfileRoot(root, 'claude', { claude: legacyClaude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.profiles.claude).not.toHaveProperty('permissionSource');
    expect(saved.migrations?.permissionDefaultsV1).toContain('claude');
  });

  it('canonicalizes legacy Claude read-only sandbox without widening permissions', async () => {
      const root = await tmpRoot();
      const legacyClaude = createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: { app },
      }) as unknown as Record<string, unknown>;
      legacyClaude.sandbox = {
        default: 'read-only',
        max: 'read-only',
        defaultMode: 'read-only',
        maxMode: 'read-only',
      };
      delete legacyClaude.permissions;
      delete legacyClaude.permissionSource;
      await writeProfileRoot(root, 'claude', { claude: legacyClaude });

      const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
      const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
        profiles: Record<string, {
          permissions?: unknown;
          sandbox?: unknown;
          permissionSource?: unknown;
        }>;
      };

      expect(runtime.profileConfig.permissions).toEqual({
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      });
      expect(runtime.profileConfig.sandbox).toMatchObject({
        defaultMode: 'read-only',
        maxMode: 'read-only',
      });
      expect(saved.profiles.claude?.permissions).toEqual({
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      });
      expect(saved.profiles.claude).not.toHaveProperty('sandbox');
      expect(saved.profiles.claude).not.toHaveProperty('permissionSource');
  });

  it('upgrades unmarked canonical Claude workspace defaults from internal migrations', async () => {
    const root = await tmpRoot();
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'claude', { claude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('claude');
  });

  it('keeps marked canonical Claude workspace permissions for users who lower access after migration', async () => {
    const root = await tmpRoot();
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'claude', { claude }, {
      migrations: { permissionDefaultsV1: ['claude'] },
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('claude');
  });

  it('keeps unmarked canonical Claude workspace override as explicit lower access', async () => {
    const root = await tmpRoot();
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
        claude: {
          permissionMode: 'acceptEdits',
        },
      },
    });
    await writeProfileRoot(root, 'claude', { claude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      claude: {
        permissionMode: 'acceptEdits',
      },
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      claude: {
        permissionMode: 'acceptEdits',
      },
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('claude');
  });

  it('keeps legacy Claude mixed lower sandbox permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const legacyClaude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    }) as unknown as Record<string, unknown>;
    legacyClaude.sandbox = {
      default: 'read-only',
      max: 'workspace-write',
      defaultMode: 'read-only',
      maxMode: 'workspace-write',
    };
    delete legacyClaude.permissions;
    delete legacyClaude.permissionSource;
    await writeProfileRoot(root, 'claude', { claude: legacyClaude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'workspace-write',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.profiles.claude).not.toHaveProperty('permissionSource');
  });

  it('keeps explicit canonical lower permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    await writeProfileRoot(root, 'claude', { claude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'read-only',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles.claude).not.toHaveProperty('sandbox');
    expect(saved.profiles.claude).not.toHaveProperty('permissionSource');
  });

  it('upgrades legacy isolated Codex config even after sandbox was already upgraded', async () => {
    const root = await tmpRoot();
    const legacyCodex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: { binaryPath: '/usr/local/bin/codex' },
    }) as unknown as Record<string, unknown>;
    delete legacyCodex.permissions;
    delete legacyCodex.permissionSource;
    (legacyCodex.codex as { inheritCodexHome?: boolean }).inheritCodexHome = false;
    (legacyCodex.codex as { ignoreUserConfig?: boolean }).ignoreUserConfig = true;
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': legacyCodex,
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { codex?: { inheritCodexHome?: boolean; ignoreUserConfig?: boolean } }>;
    };

    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
    expect(runtime.profileConfig.codex?.inheritCodexHome).toBe(true);
    expect(runtime.profileConfig.codex?.ignoreUserConfig).toBe(false);
    expect(saved.profiles['codex-dev']?.codex?.inheritCodexHome).toBe(true);
    expect(saved.profiles['codex-dev']?.codex?.ignoreUserConfig).toBe(false);
  });

  it('keeps explicit canonical Codex home and user-config isolation settings', async () => {
    const root = await tmpRoot();
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        inheritCodexHome: false,
        ignoreUserConfig: true,
      },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
      },
    });
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': codex,
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { codex?: { inheritCodexHome?: boolean; ignoreUserConfig?: boolean } }>;
    };

    expect(runtime.profileConfig.codex?.inheritCodexHome).toBe(false);
    expect(runtime.profileConfig.codex?.ignoreUserConfig).toBe(true);
    expect(saved.profiles['codex-dev']?.codex?.inheritCodexHome).toBe(false);
    expect(saved.profiles['codex-dev']?.codex?.ignoreUserConfig).toBe(true);
  });

  it('creates a managed default workspace for profiles without a default', async () => {
    const root = await tmpRoot();
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });
    profile.workspaces = {};
    await writeProfileRoot(root, 'claude', { claude: profile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'claude' }).defaultWorkspaceDir);
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
  });

  it('lets an explicit profile override active-profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex-dev', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'claude',
    });

    expect(runtime.profile).toBe('claude');
    expect(runtime.profileConfig.agentKind).toBe('claude');
  });

  it('rejects an explicit agent that conflicts with an existing profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex', {
      codex: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    });

    let error: Error | undefined;
    try {
      await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'codex',
        agent: 'codex',
        allowBootstrap: true,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      error = err;
    }

    expect(error).toBeDefined();
    const message = error?.message ?? '';
    expect(message).toContain('profile codex already exists with agentKind claude');
    expect(message).toContain('requested --agent codex');
    expect(message).toContain('Profile names are labels');
    expect(message).toContain('omit --agent');
    expect(message).toContain('remove profile codex');
  });

  it('fails when active-profile points at a missing profile instead of falling back', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'missing-profile', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    });

    await expect(
      resolveProfileRuntime({ config: join(root, 'config.json') }),
    ).rejects.toThrow(/profile not found/i);
  });

  it('bootstraps an explicit missing profile into an existing v2 root config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });
    wizard.next = {
      accounts: {
        app: {
          id: 'cli_claude_regression',
          secret: 'new-profile-secret',
          tenant: 'feishu',
        },
      },
      preferences: {},
    };

    const runtime = await withTty(true, true, () =>
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'claude-regression',
        agent: 'claude',
        workspace,
        allowBootstrap: true,
      }),
    );
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      activeProfile: string;
      profiles: Record<string, { agentKind: string; accounts: { app: { id: string } } }>;
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude-regression' });
    const secret = await getSecret(secretKeyForApp('cli_claude_regression'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(runtime.profile).toBe('claude-regression');
    expect(runtime.profileConfig.agentKind).toBe('claude');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('codex-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('codex-dev\n');
    expect(saved.profiles['codex-dev']?.agentKind).toBe('codex');
    expect(saved.profiles['claude-regression']?.agentKind).toBe('claude');
    expect(saved.profiles['claude-regression']?.accounts.app.id).toBe('cli_claude_regression');
    expect(secret).toBe('new-profile-secret');
  });

  it('normalizes stored v2 profiles before exposing runtime config', async () => {
    const root = await tmpRoot();
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: { binaryPath: '/usr/local/bin/codex' },
    }) as unknown as Record<string, unknown>;
    codex.codex = {
      ...(codex.codex as Record<string, unknown>),
      flags: ['--danger-full-access'],
    };
    codex.workspaces = {
      default: '/repo/project',
      trustedRoots: ['/repo'],
    };
    await writeProfileRoot(root, 'codex-dev', { 'codex-dev': codex });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profileConfig.workspaces.default).toBe('/repo/project');
    expect(runtime.profileConfig.codex).not.toHaveProperty('flags');
  });

  it('materializes env-backed secrets into encrypted profile storage for service mode', async () => {
    const root = await tmpRoot();
    process.env.BRIDGE_TEST_APP_SECRET = 'service-mode-secret';
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: {
            id: 'cli_codex',
            secret: { source: 'env', id: 'BRIDGE_TEST_APP_SECRET' },
            tenant: 'feishu',
          },
        },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const changed = await materializeEnvSecretForService({
      config: join(root, 'config.json'),
      profile: 'codex-dev',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { accounts: { app: { secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });
    const secret = await getSecret(secretKeyForApp('cli_codex'), appPaths);
    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'codex-dev',
      allowBootstrap: false,
    });
    const projectionPath = await writeLarkCliSourceProjection(runtime.cfg, appPaths);
    const projectionText = await readFile(projectionPath, 'utf8');
    const projection = JSON.parse(projectionText) as {
      accounts: { app: { secret: unknown } };
      secrets?: { providers?: Record<string, { command?: string; env?: Record<string, string> }> };
    };

    expect(changed).toBe(true);
    expect(saved.profiles['codex-dev']?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_codex',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(secret).toBe('service-mode-secret');
    expect(projectionText).not.toContain('${BRIDGE_TEST_APP_SECRET}');
    expect(projection.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_codex',
    });
    expect(projection.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(projection.secrets?.providers?.bridge?.env).toMatchObject({
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_PROFILE: 'codex-dev',
    });
  });
});

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-profile-runtime-'));
}

async function writeExecutable(root: string, name: string): Promise<string> {
  return writeVersionExecutable(root, name, 'ok');
}

function expectedSecretsGetter(root: string): string {
  const script = join(root, 'secrets-getter');
  return process.platform === 'win32' ? `${script}.cmd` : script;
}

async function writeProfileRoot(
  root: string,
  activeProfile: string,
  profiles: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      activeProfile,
      preferences: {},
      ...extra,
      profiles,
    }, null, 2)}\n`,
  );
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`);
}

async function withTty<T>(
  stdinTTY: boolean,
  stdoutTTY: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY });
  try {
    return await fn();
  } finally {
    restoreDescriptor(process.stdin, 'isTTY', stdinDesc);
    restoreDescriptor(process.stdout, 'isTTY', stdoutDesc);
  }
}

function restoreDescriptor(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  key: 'isTTY',
  desc: PropertyDescriptor | undefined,
): void {
  if (desc) {
    Object.defineProperty(target, key, desc);
  } else {
    delete (target as unknown as Record<string, unknown>)[key];
  }
}
