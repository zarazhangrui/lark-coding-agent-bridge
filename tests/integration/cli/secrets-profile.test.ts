import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateBridgeEnv, restoreBridgeEnv } from '../../helpers/bridge-env';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  clearKeystoreDerivedKeyCache,
  getSecret,
  keystoreDerivedKeyCacheSize,
  setSecret,
} from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';
import {
  removeAppSecret,
  resolveSecretAcrossProfiles,
  setAppSecret,
} from '../../../src/cli/commands/secrets';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-secrets-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  isolateBridgeEnv();
});

afterEach(() => {
  restoreBridgeEnv();
});

describe('profile-aware secrets commands', () => {
  it('resolves secrets active-first, then by profile name, and warns on duplicates', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['alpha', 'codex-dev', 'zeta']);
    const duplicate = secretKeyForApp('cli_duplicate');
    await setSecret(duplicate, 'from-active', resolveAppPaths({ rootDir: root, profile: 'codex-dev' }));
    await setSecret(duplicate, 'from-alpha', resolveAppPaths({ rootDir: root, profile: 'alpha' }));
    const fallback = secretKeyForApp('cli_fallback');
    await setSecret(fallback, 'from-zeta', resolveAppPaths({ rootDir: root, profile: 'zeta' }));
    await setSecret(fallback, 'from-alpha', resolveAppPaths({ rootDir: root, profile: 'alpha' }));
    const warnings: string[] = [];

    await expect(resolveSecretAcrossProfiles(duplicate, root, (msg) => warnings.push(msg))).resolves.toBe(
      'from-active',
    );
    await expect(resolveSecretAcrossProfiles(fallback, root, (msg) => warnings.push(msg))).resolves.toBe(
      'from-alpha',
    );

    expect(warnings).toEqual([
      expect.stringContaining('secret app-cli_duplicate exists in multiple profiles; using codex-dev'),
      expect.stringContaining('secret app-cli_fallback exists in multiple profiles; using alpha'),
    ]);
  });

  it('sets and removes secrets in an explicit profile or the active profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['alpha', 'codex-dev']);

    await setAppSecret('cli_alpha', 'alpha-secret', { rootDir: root, profile: 'alpha' });
    await setAppSecret('cli_active', 'active-secret', { rootDir: root });

    await expect(
      getSecret(secretKeyForApp('cli_alpha'), resolveAppPaths({ rootDir: root, profile: 'alpha' })),
    ).resolves.toBe('alpha-secret');
    await expect(
      getSecret(secretKeyForApp('cli_active'), resolveAppPaths({ rootDir: root, profile: 'codex-dev' })),
    ).resolves.toBe('active-secret');

    await expect(removeAppSecret('cli_alpha', { rootDir: root, profile: 'alpha' })).resolves.toBe(true);
    await expect(
      getSecret(secretKeyForApp('cli_alpha'), resolveAppPaths({ rootDir: root, profile: 'alpha' })),
    ).resolves.toBeUndefined();
  });

  it('uses LARK_CHANNEL_PROFILE to resolve duplicate secret ids within one profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['alpha', 'codex-dev']);
    const duplicate = secretKeyForApp('cli_duplicate');
    await setSecret(duplicate, 'from-codex', resolveAppPaths({ rootDir: root, profile: 'codex-dev' }));
    await setSecret(duplicate, 'from-alpha', resolveAppPaths({ rootDir: root, profile: 'alpha' }));
    const warnings: string[] = [];

    await expect(
      resolveSecretAcrossProfiles(duplicate, root, (msg) => warnings.push(msg), 'alpha'),
    ).resolves.toBe('from-alpha');

    expect(warnings).toEqual([]);
  });

  it('caches the derived keystore key within one secrets process', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await setSecret(secretKeyForApp('cli_one'), 'one', appPaths);
    await setSecret(secretKeyForApp('cli_two'), 'two', appPaths);
    clearKeystoreDerivedKeyCache();

    await expect(getSecret(secretKeyForApp('cli_one'), appPaths)).resolves.toBe('one');
    await expect(getSecret(secretKeyForApp('cli_two'), appPaths)).resolves.toBe('two');

    expect(keystoreDerivedKeyCacheSize()).toBe(1);
  });
});

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
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`, 'utf8');
}
