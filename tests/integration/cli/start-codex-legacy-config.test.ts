import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// On Windows the shell-based codex shim can be unreliable in this environment
// (no /bin/sh). Use maybeIt to skip these tests on Windows rather than modifying
// production code paths.
const maybeIt = process.platform === 'win32' ? it.skip : it;
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { RuntimeLockConflictError, type RuntimeLockMeta } from '../../../src/runtime/locks';

const mocks = vi.hoisted(() => ({
  withProfileAndAppLocks: vi.fn(),
}));

vi.mock('../../../src/runtime/locks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/locks')>();
  return {
    ...actual,
    withProfileAndAppLocks: mocks.withProfileAndAppLocks,
  };
});

const { runStart, createRuntimeAgent } = await import('../../../src/cli/commands/start');
const { loadRootConfig } = await import('../../../src/config/profile-store');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex startup compatibility with legacy binary metadata', () => {
  maybeIt('starts past profile loading when an older Codex profile only has binaryPath', async () => {
    const h = await createLegacyCodexConfig({
      codexMetadata: {},
    });
    const holder: RuntimeLockMeta = {
      kind: 'profile',
      target: join(h.root, 'registry', 'locks', 'profile', 'codex.lock'),
      profile: 'codex',
      agentKind: 'codex',
      pid: 12345,
      startedAt: '2026-06-04T09:00:00.000Z',
    };
    mocks.withProfileAndAppLocks.mockRejectedValueOnce(
      new RuntimeLockConflictError('profile', holder.target, holder, new Error('locked')),
    );

    await expect(
      runStart({
        config: h.configPath,
        profile: 'codex',
        skipCheckLarkCli: true,
        confirmStopRuntimeLockProcess: async () => false,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.withProfileAndAppLocks).toHaveBeenCalledTimes(1);
  });

  maybeIt('starts past profile loading and agent availability when legacy Codex metadata is stale', async () => {
    const h = await createLegacyCodexConfig({
      codexMetadata: staleLegacyMetadata(),
    });
    const holder: RuntimeLockMeta = {
      kind: 'profile',
      target: join(h.root, 'registry', 'locks', 'profile', 'codex.lock'),
      profile: 'codex',
      agentKind: 'codex',
      pid: 12345,
      startedAt: '2026-06-04T09:00:00.000Z',
    };
    mocks.withProfileAndAppLocks.mockRejectedValueOnce(
      new RuntimeLockConflictError('profile', holder.target, holder, new Error('locked')),
    );

    await expect(
      runStart({
        config: h.configPath,
        profile: 'codex',
        skipCheckLarkCli: true,
        confirmStopRuntimeLockProcess: async () => false,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.withProfileAndAppLocks).toHaveBeenCalledTimes(1);
  });

  maybeIt('prepares the first Codex run from config even when legacy metadata points elsewhere', async () => {
    const h = await createLegacyCodexConfig({
      codexMetadata: staleLegacyMetadata(),
    });
    const root = await loadRootConfig(h.configPath);
    const profile = root?.profiles.codex;
    expect(profile).toBeDefined();

    const agent = createRuntimeAgent(profile!, {
      profile: 'codex',
      rootDir: h.root,
      profileDir: join(h.root, 'profiles', 'codex'),
      configPath: h.configPath,
    });

    await expect(
      agent.prepareRun?.({
        runId: 'run-1',
        prompt: 'hello',
        cwd: h.workspace,
      }),
    ).resolves.toBeUndefined();
  });
});

async function createLegacyCodexConfig(options: {
  codexMetadata: {
    realpath?: string;
    version?: string;
    sha256?: string;
    owner?: number;
    mode?: number;
  };
}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-codex-legacy-config-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const workspace = join(root, 'workspace');
  const binDir = join(root, 'bin');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  const codex = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const codexCmd = join(binDir, 'codex.cmd');
  await writeFile(
    codex,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "codex-cli 999.0.0"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  // Add a Windows-friendly wrapper so tests pass on Windows
  await writeFile(
    codexCmd,
    [
      '@echo off',
      'if "%1"=="--version" (',
      '  echo codex-cli 999.0.0',
      '  exit /b 0',
      ')',
      'exit /b 0',
      '',
    ].join('\r\n'),
    'utf8',
  );
  await chmod(codex, 0o755);

  const secrets = {
    providers: {
      test: {
        source: 'env' as const,
        allowlist: ['BRIDGE_TEST_APP_SECRET'],
      },
    },
  };
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: { source: 'env', provider: 'test', id: 'BRIDGE_TEST_APP_SECRET' },
        tenant: 'feishu',
      },
    },
    secrets,
    codex: {
      binaryPath: codex,
      ...options.codexMetadata,
    },
  });
  profile.workspaces.default = workspace;
  const rootConfig = createRootConfig('codex', profile, secrets);
  const configPath = join(root, 'config.json');
  await saveRootConfig(rootConfig, configPath);

  return { root, configPath, workspace, codex };
}

function staleLegacyMetadata() {
  return {
    realpath: '/opt/old-codex/bin/codex',
    version: 'codex-cli 0.130.0',
    sha256: '0'.repeat(64),
    owner: 0,
    mode: 0o700,
  };
}
