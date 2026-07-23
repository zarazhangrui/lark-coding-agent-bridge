import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { listAllProfiles } from '../../../src/runtime/profile-discovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-discovery-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listAllProfiles', () => {
  it('lists profiles from root config with active profile first and others sorted', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'claude',
      profiles: {
        zeta: profile('claude', 'cli_zeta'),
        claude: profile('claude', 'cli_claude'),
        'codex-dev': profile('codex', 'cli_codex'),
      },
    });
    await writeFile(join(root, 'active-profile'), 'codex-dev\n', 'utf8');
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
    await mkdir(join(root, 'profiles', 'codex-dev'), { recursive: true });
    await mkdir(join(root, 'profiles', 'zeta'), { recursive: true });

    const profiles = await listAllProfiles(root);

    expect(profiles.map((item) => item.name)).toEqual(['codex-dev', 'claude', 'zeta']);
    expect(profiles.map((item) => item.active)).toEqual([true, false, false]);
    expect(profiles[0]).toMatchObject({
      agentKind: 'codex',
      profileDir: join(root, 'profiles', 'codex-dev'),
    });
  });

  it('fails when active-profile points at a missing profile', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'claude',
      profiles: {
        claude: profile('claude', 'cli_claude'),
      },
    });
    await writeFile(join(root, 'active-profile'), 'missing\n', 'utf8');
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow('active profile not found: missing');
  });

  it('fails when config profiles are missing state directories', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'claude',
      profiles: {
        claude: profile('claude', 'cli_claude'),
        'codex-dev': profile('codex', 'cli_codex'),
      },
    });
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow('profile state directory missing: codex-dev');
  });

  it('fails when a state directory has no matching config profile', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'claude',
      profiles: {
        claude: profile('claude', 'cli_claude'),
      },
    });
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
    await mkdir(join(root, 'profiles', 'orphan'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow(
      'profile state directory without config: orphan',
    );
  });

  it('ignores a log-only orphan profile directory left by early startup logging', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'codex-dev',
      profiles: {
        'codex-dev': profile('codex', 'cli_codex'),
      },
    });
    await mkdir(join(root, 'profiles', 'codex-dev'), { recursive: true });
    await mkdir(join(root, 'profiles', 'claude', 'logs'), { recursive: true });
    await writeFile(
      join(root, 'profiles', 'claude', 'logs', 'bridge-20260526.jsonl'),
      '{}\n',
      'utf8',
    );

    await expect(listAllProfiles(root)).resolves.toMatchObject([
      { name: 'codex-dev', active: true },
    ]);
  });

  it('does not treat a malformed configured profile dropped during normalization as orphan state', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'claude',
      profiles: {
        claude: profile('claude', 'cli_claude'),
        opencode: {
          ...profile('claude', 'cli_opencode'),
          agentKind: 'opencode',
        },
      },
    } as Pick<RootConfig, 'activeProfile' | 'profiles'>);
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
    await mkdir(join(root, 'profiles', 'opencode'), { recursive: true });

    await expect(listAllProfiles(root)).resolves.toMatchObject([
      { name: 'claude', active: true },
    ]);
  });
});

function profile(agentKind: AgentKind, appId: string) {
  return createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: appId,
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
  });
}

async function writeRootConfig(
  root: string,
  overrides: Pick<RootConfig, 'activeProfile' | 'profiles'>,
): Promise<void> {
  const config: RootConfig = {
    schemaVersion: 2,
    preferences: {},
    ...overrides,
  };
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
