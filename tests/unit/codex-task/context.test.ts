import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexTaskContext } from '../../../src/codex-task/context';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';

describe('resolveCodexTaskContext', () => {
  const cleanup: string[] = [];
  const originalProfile = process.env.LARK_CHANNEL_PROFILE;
  const originalBridgeConfig = process.env.LARK_CHANNEL_BRIDGE_CONFIG;

  afterEach(async () => {
    if (originalProfile === undefined) delete process.env.LARK_CHANNEL_PROFILE;
    else process.env.LARK_CHANNEL_PROFILE = originalProfile;
    if (originalBridgeConfig === undefined) delete process.env.LARK_CHANNEL_BRIDGE_CONFIG;
    else process.env.LARK_CHANNEL_BRIDGE_CONFIG = originalBridgeConfig;
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses explicit profile, then bridge environment, then active-profile without rewriting config', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'codex-task-context-'));
    cleanup.push(rootDir);
    const root: RootConfig = {
      schemaVersion: 2,
      activeProfile: 'root-default',
      preferences: {},
      profiles: {
        explicit: profile(),
        environment: profile(),
        active: profile(),
        'root-default': profile(),
      },
    };
    const configPath = resolveAppPaths({ rootDir }).configFile;
    await saveRootConfig(root, configPath);
    await writeActiveProfile(rootDir, 'active');
    const before = await readFile(configPath, 'utf8');
    process.env.LARK_CHANNEL_PROFILE = 'environment';

    await expect(resolveCodexTaskContext({ rootDir, profile: 'explicit' })).resolves.toMatchObject({
      profile: 'explicit',
    });
    await expect(resolveCodexTaskContext({ rootDir })).resolves.toMatchObject({
      profile: 'environment',
    });
    delete process.env.LARK_CHANNEL_PROFILE;
    await expect(resolveCodexTaskContext({ rootDir })).resolves.toMatchObject({
      profile: 'active',
    });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('loads the exact custom Bridge config passed explicitly or inherited from the Bridge', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'codex-task-context-custom-'));
    cleanup.push(rootDir);
    const customConfig = join(rootDir, 'custom.json');
    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'custom',
      preferences: {},
      profiles: { custom: profile() },
    }, customConfig);

    process.env.LARK_CHANNEL_BRIDGE_CONFIG = customConfig;
    await expect(resolveCodexTaskContext({})).resolves.toMatchObject({
      profile: 'custom',
      configPath: customConfig,
    });
    await expect(resolveCodexTaskContext({ config: customConfig })).resolves.toMatchObject({
      profile: 'custom',
      configPath: customConfig,
    });
  });
});

function profile(): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } },
    codex: {
      binaryPath: 'codex',
      transport: 'app-server',
      inheritCodexHome: true,
    },
  });
}
