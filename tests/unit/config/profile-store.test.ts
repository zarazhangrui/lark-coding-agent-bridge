import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-store-'));
  roots.push(root);
  return root;
}

describe('profile store canonical serialization', () => {
  it('saves stored root and profile config without unknown root fields or runtime-only profile fields', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const rootSecrets = {
      providers: {
        rootEnv: {
          source: 'env' as const,
          allowlist: ['APP_SECRET'],
        },
      },
      defaults: { env: 'rootEnv' },
    };
    const profile = {
      ...createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app },
        secrets: { defaults: { env: 'profileEnv' } },
        preferences: {
          messageReply: 'markdown',
          showToolCalls: false,
        },
        access: {
          allowedUsers: ['ou_user'],
          allowedChats: ['oc_chat'],
          admins: ['ou_admin'],
          requireMentionInGroup: false,
        },
        codex: {
          binaryPath: '/usr/local/bin/codex',
          codexHome: '/tmp/codex-home',
          inheritCodexHome: false,
        },
        permissions: {
          defaultAccess: 'workspace',
          maxAccess: 'full',
        },
      }),
      workspaces: { default: '/repo' },
      attachments: {
        maxCount: 2,
        maxBytes: 1024,
        maxFileBytes: 512,
        imageMaxBytes: 256,
        cacheTtlMs: 60_000,
        cacheMaxBytes: 2048,
      },
      comments: {},
      larkCli: {
        identityPreset: 'user-default' as const,
        localUserImport: {
          status: 'imported' as const,
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
        },
      },
      runtimeOnlyFutureField: true,
    };

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: { messageReply: 'text' },
      secrets: rootSecrets,
      migrations: {
        permissionDefaultsV1: [
          'codex',
          'codex',
          '  claude  ',
          'claude',
          'claude ',
          '',
          42 as unknown as string,
        ],
      },
      profiles: { codex: profile },
      extra: true,
    } as unknown as RootConfig & { extra?: true; preferences: any }, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.activeProfile).toBe('codex');
    expect(saved.secrets).toEqual(rootSecrets);
    expect(saved.preferences).toEqual({});
    expect(saved.migrations).toEqual({ permissionDefaultsV1: ['claude', 'codex'] });
    expect(saved).not.toHaveProperty('extra');

    const savedProfile = saved.profiles.codex;
    expect(savedProfile.accounts).toEqual(profile.accounts);
    expect(savedProfile.secrets).toEqual(profile.secrets);
    expect(savedProfile.preferences).toEqual(profile.preferences);
    expect(savedProfile.access).toEqual(profile.access);
    expect(savedProfile.workspaces).toEqual(profile.workspaces);
    expect(savedProfile.codex).toEqual(profile.codex);
    expect(savedProfile.attachments).toEqual(profile.attachments);
    expect(savedProfile.comments).toEqual(profile.comments);
    expect(savedProfile.larkCli).toEqual(profile.larkCli);
    expect(savedProfile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'full',
    });
    expect(savedProfile).not.toHaveProperty('runtimeOnlyFutureField');
    expect(savedProfile).not.toHaveProperty('permissionSource');
    expect(savedProfile).not.toHaveProperty('sandbox');
  });

  it('round-trips an opencode profile, preserving the opencode (binaryPath) block', async () => {
    // Regression: serializeProfileConfig listed `codex` but not `opencode`,
    // so saving an opencode profile silently dropped its binaryPath block.
    // The next load then failed "opencode profile requires opencode
    // configuration", taking down the whole bridge.
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'opencode',
      accounts: { app },
      opencode: { binaryPath: '/usr/local/bin/opencode', inheritConfig: true },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'opencode',
      preferences: {},
      profiles: { opencode: profile },
    }, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.opencode.opencode).toEqual({
      binaryPath: '/usr/local/bin/opencode',
      inheritConfig: true,
    });

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.opencode?.opencode).toEqual({
      binaryPath: '/usr/local/bin/opencode',
      inheritConfig: true,
    });
  });

  it('loads canonical-only saved config and re-derives runtime sandbox', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: {},
      profiles: { codex: profile },
    }, configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.codex?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(loaded?.profiles.codex?.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('persists deployment mode across save→load round-trip', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      mode: 'team',
      accounts: { app },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      profiles: { claude: profile },
    }, configPath);

    // On disk: mode is written (not stripped by the serializer).
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.mode).toBe('team');

    // Reloaded: mode survives, so team mode is not silently lost on restart.
    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.mode).toBe('team');
  });

  it('persists per-chat @-mention overrides across save→load round-trip', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    profile.access.chatRequireMention = { oc_open: false, oc_strict: true };

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      profiles: { claude: profile },
    }, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.access.chatRequireMention).toEqual({
      oc_open: false,
      oc_strict: true,
    });

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.access.chatRequireMention).toEqual({
      oc_open: false,
      oc_strict: true,
    });
  });

  it('marks newly created roots as already evaluated for permission default migration', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    const root = createRootConfig('claude', profile);

    expect(root.migrations?.permissionDefaultsV1).toEqual(['claude']);
  });

  it('loads healthy profiles even when one profile is malformed (missing required agent block)', async () => {
    // A root config may contain a profile that was saved in an earlier
    // version without a required agent-specific block (e.g. an opencode
    // profile missing its `opencode` block). Such a profile cannot be
    // normalized, but it must not poison loading of the other profiles —
    // otherwise a single bad entry takes down the whole bridge (every
    // loadRootConfig throws). Drop the malformed profile and keep the rest.
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const goodClaude = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    // Manually write a root config whose `opencode` profile is malformed
    // (agentKind opencode, but no opencode block — exactly the shape that
    // broke loading before this fix).
    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      profiles: { claude: goodClaude },
    }, configPath);
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    raw.profiles.opencode = {
      schemaVersion: 2,
      agentKind: 'opencode',
      mode: 'personal',
      accounts: { app },
      access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: true },
      workspaces: { default: '/tmp/ws' },
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
      attachments: { maxCount: 1, maxBytes: 1, maxFileBytes: 1, imageMaxBytes: 1, cacheTtlMs: 1, cacheMaxBytes: 1 },
      comments: {},
      larkCli: { identityPreset: 'bot-only' },
    };
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    const loaded = await loadRootConfig(configPath);
    // The healthy claude profile survives:
    expect(loaded?.profiles.claude?.agentKind).toBe('claude');
    // The malformed opencode profile was dropped (not left in a broken state):
    expect(loaded?.profiles.opencode).toBeUndefined();
  });
});
