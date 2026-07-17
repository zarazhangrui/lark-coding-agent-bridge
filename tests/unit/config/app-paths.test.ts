import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-app-paths-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveAppPaths', () => {
  it('keeps root config, active profile, registry, and locks under the user root', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });

    expect(paths.rootDir).toBe(root);
    expect(paths.profile).toBe('codex-dev');
    expect(paths.configFile).toBe(join(root, 'config.json'));
    expect(paths.activeProfileFile).toBe(join(root, 'active-profile'));
    expect(paths.registryDir).toBe(join(root, 'registry'));
    expect(paths.userRegistryFile).toBe(join(root, 'registry', 'processes.json'));
    expect(paths.userLockDir).toBe(join(root, 'registry', 'locks'));
    expect(paths.profileLockFile).toBe(join(root, 'registry', 'locks', 'profile', 'codex-dev.lock'));
    expect(paths.appLockFile('cli_app')).toBe(join(root, 'registry', 'locks', 'app', 'cli_app.lock'));
  });

  it('places runtime state inside the selected profile directory', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });

    const profileDir = join(root, 'profiles', 'claude');
    expect(paths.profileDir).toBe(profileDir);
    expect(paths.defaultWorkspaceDir).toBe(join(`${root}-workspaces`, 'claude', 'default'));
    expect(paths.sessionsFile).toBe(join(profileDir, 'sessions.json'));
    expect(paths.workspacesFile).toBe(join(profileDir, 'workspaces.json'));
    expect(paths.secretsFile).toBe(join(profileDir, 'secrets.enc'));
    expect(paths.keystoreSaltFile).toBe(join(profileDir, '.keystore.salt'));
    expect(paths.larkCliConfigDir).toBe(join(profileDir, 'lark-cli'));
    expect(paths.larkCliSourceDir).toBe(join(profileDir, 'lark-cli-source'));
    expect(paths.larkCliSourceConfigFile).toBe(join(profileDir, 'lark-cli-source', 'config.json'));
    expect(paths.larkCliTargetConfigFile).toBe(join(profileDir, 'lark-cli', 'lark-channel', 'config.json'));
    expect(paths.mediaDir).toBe(join(profileDir, 'media'));
    expect(paths.logsDir).toBe(join(profileDir, 'logs'));
    expect(paths.secretsGetterScript).toBe(join(root, 'secrets-getter'));
  });

  it('uses LARK_CHANNEL_HOME only for the root directory, not profile selection', async () => {
    const root = await tempRoot();
    const prev = process.env.LARK_CHANNEL_HOME;
    process.env.LARK_CHANNEL_HOME = root;
    try {
      const paths = resolveAppPaths({ profile: 'operator-choice' });
      expect(paths.rootDir).toBe(root);
      expect(paths.profile).toBe('operator-choice');
      expect(paths.profileDir).toBe(join(root, 'profiles', 'operator-choice'));
    } finally {
      if (prev === undefined) {
        delete process.env.LARK_CHANNEL_HOME;
      } else {
        process.env.LARK_CHANNEL_HOME = prev;
      }
    }
  });

  it('rejects profile names that cannot be used directly in locks and service ids', async () => {
    const root = await tempRoot();

    expect(() => resolveAppPaths({ rootDir: root, profile: 'codex dev' })).toThrow(/invalid profile name/i);
    expect(() => resolveAppPaths({ rootDir: root, profile: 'b64_Y29kZXggZGV2' })).not.toThrow();
    // Path-dangerous / reserved chars are still rejected.
    expect(() => resolveAppPaths({ rootDir: root, profile: 'a/b' })).toThrow(/invalid profile name/i);
    expect(() => resolveAppPaths({ rootDir: root, profile: '..' })).toThrow(/invalid profile name/i);
    expect(() => resolveAppPaths({ rootDir: root, profile: 'a:b' })).toThrow(/invalid profile name/i);
  });

  it('accepts Unicode profile names (e.g. a Chinese bot name) as a directory segment', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: '尼莫' });

    expect(paths.profile).toBe('尼莫');
    expect(paths.profileDir).toBe(join(root, 'profiles', '尼莫'));
    expect(paths.profileLockFile).toBe(join(root, 'registry', 'locks', 'profile', '尼莫.lock'));
  });
});
