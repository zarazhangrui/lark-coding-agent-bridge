import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/schema';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { isolateBridgeEnv, restoreBridgeEnv } from '../../helpers/bridge-env';

const mocks = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
  spawnProcessSync: vi.fn(),
  atomicWriteFailures: [] as Array<{ path: string; err: Error }>,
  calls: [] as Array<{
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }>,
  exitCodes: [] as number[],
  outputs: [] as string[],
  onSpawn: undefined as undefined | ((callIndex: number, args: string[], env?: NodeJS.ProcessEnv) => void),
}));

vi.mock('../../../src/platform/atomic-write', async () => {
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>(
    '../../../src/platform/atomic-write',
  );
  return {
    ...actual,
    writeFileAtomic: async (
      path: string,
      data: string | Buffer,
      opts?: import('../../../src/platform/atomic-write').AtomicWriteOptions,
    ) => {
      const failure = mocks.atomicWriteFailures.find((candidate) => candidate.path === path);
      if (failure) throw failure.err;
      return actual.writeFileAtomic(path, data, opts);
    },
  };
});

vi.mock('../../../src/platform/spawn', () => ({
  mergeProcessEnv: (base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv) => ({
    ...base,
    ...overrides,
  }),
  spawnProcess: mocks.spawnProcess,
  spawnProcessSync: mocks.spawnProcessSync,
}));

const { preFlightChecks } = await import('../../../src/cli/preflight');
const { resolveAppPaths } = await import('../../../src/config/app-paths');
const { log } = await import('../../../src/core/logger');

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-preflight-'));
  roots.push(root);
  return root;
}

const bridgeConfig: AppConfig = {
  accounts: {
    app: {
      id: 'cli_codex',
      tenant: 'feishu',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: 'app-cli_codex',
      },
    },
  },
  secrets: {
    providers: {
      bridge: {
        source: 'exec',
        command: '/stale/secrets-getter',
        args: [],
      },
    },
  },
};

describe('lark-cli preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls = [];
    mocks.atomicWriteFailures = [];
    mocks.exitCodes = [];
    mocks.outputs = [];
    mocks.onSpawn = undefined;
    mocks.spawnProcessSync.mockReturnValue({ status: 0 });
    mocks.spawnProcess.mockImplementation(
      (cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
        mocks.calls.push({ cmd, args, env: options.env });
        mocks.onSpawn?.(mocks.calls.length, args, options.env);
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        const exitCode = mocks.exitCodes.shift() ?? 0;
        const output = mocks.outputs.shift() ?? '';
        queueMicrotask(() => {
          if (output) child.stderr.write(output);
          child.emit('exit', exitCode);
        });
        return child;
      },
    );
    isolateBridgeEnv();
  });

  afterEach(async () => {
    restoreBridgeEnv();
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('binds lark-cli into the bridge-private config dir when target config is missing', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    mocks.exitCodes = [0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex',
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    const source = JSON.parse(await readFile(appPaths.larkCliSourceConfigFile, 'utf8')) as {
      accounts: { app: { id: string } };
    };
    expect(source.accounts.app.id).toBe('cli_codex');
  });

  it('falls back through a locked root source overlay for lark-cli builds without LARK_CHANNEL_CONFIG support', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeFile(
      appPaths.configFile,
      `${JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'codex',
        profiles: {
          codex: {
            accounts: bridgeConfig.accounts,
            agentKind: 'codex',
          },
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const originalRoot = await readFile(appPaths.configFile, 'utf8');
    mocks.exitCodes = [2, 0];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: `accounts.app.id missing in ${appPaths.configFile}`,
        },
      }),
      '',
    ];
    let rootDuringLegacyBind: { accounts?: { app?: { id?: string } } } | undefined;
    mocks.onSpawn = (callIndex) => {
      if (callIndex !== 2) return;
      rootDuringLegacyBind = JSON.parse(readFileSync(appPaths.configFile, 'utf8')) as {
        accounts?: { app?: { id?: string } };
      };
    };

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    expect(mocks.calls[1]?.env).toMatchObject({
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    expect(mocks.calls[0]?.env?.HOME).toBe(process.env.HOME);
    expect(mocks.calls[1]?.env?.HOME).toBe(process.env.HOME);
    expect(rootDuringLegacyBind?.accounts?.app?.id).toBe('cli_codex');
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('falls back when lark-cli prints a JSON-escaped bridge root path', async () => {
    const parent = await tempRoot();
    const root = join(parent, 'root\\with\\backslashes');
    await mkdir(root, { recursive: true });
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeFile(
      appPaths.configFile,
      `${JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'codex',
        profiles: {
          codex: {
            accounts: bridgeConfig.accounts,
            agentKind: 'codex',
          },
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    mocks.exitCodes = [2, 0];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: `accounts.app.id missing in ${appPaths.configFile}`,
        },
      }),
      '',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
  });

  it('restores the bridge root config when legacy overlay bind fails', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    mocks.exitCodes = [2, 3];
    mocks.outputs = [
      `accounts.app.id missing in ${appPaths.configFile}`,
      'keychain unavailable: test failure',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls).toHaveLength(2);
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('does not overlay the bridge root config when lark-cli is too old for lark-channel source', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    mocks.exitCodes = [2];
    mocks.outputs = ['invalid --source "lark-channel"; valid values: env, file'];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('treats lark-cli builds without config bind source support as too old', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.exitCodes = [1];
    mocks.outputs = [
      [
        'Usage:',
        '  lark-cli config [command]',
        '',
        'Error: unknown flag: --source',
      ].join('\n'),
    ];

    let printed = '';
    try {
      await preFlightChecks({
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath: appPaths.configFile,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
        bridgeConfig,
        appPaths,
      });
      printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(printed).toContain('does not support the lark-channel source');
    expect(printed).toContain('lark-cli does not support `config bind --source lark-channel`.');
    expect(printed).not.toContain('Available Commands');
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('omits lark-cli update notices from bind failure diagnostics', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.exitCodes = [2];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: 'permission denied while writing config',
        },
        _notice: {
          update: {
            current: '1.0.0',
            latest: '1.0.1',
            command: 'npm install -g @larksuite/cli',
          },
        },
      }),
    ];

    let printed = '';
    try {
      await preFlightChecks({
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath: appPaths.configFile,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
        bridgeConfig,
        appPaths,
      });
      printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(printed).toContain('permission denied while writing config');
    expect(printed).not.toContain('_notice');
    expect(printed).not.toContain('latest');
    expect(printed).not.toContain('npm install -g @larksuite/cli');
  });

  it('does not rebind when private target config already matches the current bridge profile', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_other',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: null,
          },
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: null,
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
  });

  it('accepts an existing private user-default target for the same app without rebind', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeRootConfig(appPaths.configFile, 'codex');
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'auto',
            strictMode: 'off',
            users: [{ openId: 'ou-user' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'user-default',
      localUserImport: { status: 'skipped-existing-private-user' },
    });
  });

  it('switches an existing same-app private user auth from bot-only to user-default without rebind', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeRootConfig(appPaths.configFile, 'codex');
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: [{ openId: 'ou-user' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 0, 0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'strict-mode', 'off'],
      ['config', 'default-as', 'auto'],
      ['config', 'show'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'user-default',
      localUserImport: { status: 'skipped-existing-private-user' },
    });
  });

  it('rolls back to bot-only when switching an existing private user auth to user-default partially fails', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeRootConfig(appPaths.configFile, 'codex');
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: [{ openId: 'ou-user' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 2, 0, 0, 0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'strict-mode', 'off'],
      ['config', 'default-as', 'auto'],
      ['config', 'strict-mode', 'bot'],
      ['config', 'default-as', 'bot'],
      ['config', 'show'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'bot-only',
      localUserImport: {
        status: 'failed',
        reason: 'private-user-policy-switch-failed',
      },
    });
  });

  it('respects a manual bot-only profile even when private user auth exists', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    profileConfig.larkCli = {
      identityPreset: 'bot-only',
      localUserImport: {
        status: 'not-needed',
        reason: 'manual-bot-only',
      },
    };
    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: {},
      profiles: { codex: profileConfig },
    }, appPaths.configFile);
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'auto',
            strictMode: 'off',
            users: [{ openId: 'ou-user' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 0, 0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'strict-mode', 'bot'],
      ['config', 'default-as', 'bot'],
      ['config', 'show'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'bot-only',
      localUserImport: {
        status: 'not-needed',
        reason: 'manual-bot-only',
      },
    });
  });

  it('uses user-default on first bind when the local lark-cli has the same app and a user login', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    const localConfig = join(root, 'local-lark-cli-config.json');
    await writeFile(
      localConfig,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            users: [{ openId: 'ou-user' }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 0, 0, 0, 0];
    mocks.outputs = [
      [
        `Config file path: ${localConfig}`,
        'warning: non-json diagnostic',
        JSON.stringify({
          appId: 'cli_codex',
          brand: 'feishu',
          users: 'User Name (ou-user)',
        }),
      ].join('\n'),
      '',
      '',
      '',
      [
        'warning: non-json diagnostic',
        JSON.stringify({
          appId: 'cli_codex',
          brand: 'feishu',
          users: 'User Name (ou-user)',
        }),
      ].join('\n'),
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
      ['config', 'strict-mode', 'off'],
      ['config', 'default-as', 'auto'],
      ['config', 'show'],
    ]);
    expect(mocks.calls[0]?.env?.LARKSUITE_CLI_CONFIG_DIR).toBeUndefined();
    expect(mocks.calls[1]?.env).toMatchObject({
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'user-default',
      localUserImport: { status: 'imported' },
    });
  });

  it('does not copy display-only no-user strings into the private target', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    const localConfig = join(root, 'local-lark-cli-config.json');
    await writeFile(
      localConfig,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            users: null,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: null,
          },
        ],
      }, null, 2),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 0];
    mocks.outputs = [
      [
        `Config file path: ${localConfig}`,
        JSON.stringify({
          appId: 'cli_codex',
          brand: 'feishu',
          users: '(no logged-in users)',
        }),
      ].join('\n'),
      '',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
      ['config', 'show'],
    ]);
    const privateTarget = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps: Array<{ users?: unknown }>;
    };
    expect(privateTarget.apps[0]?.users).toBeNull();
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'bot-only',
      localUserImport: {
        status: 'skipped-no-local-user',
        reason: 'local-user-missing',
      },
    });
  });

  it('repairs an existing private target that contains display-only users text', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    const localConfig = join(root, 'local-lark-cli-config.json');
    await writeFile(
      localConfig,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            users: null,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: '(no logged-in users)',
          },
        ],
      }, null, 2),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0, 0];
    mocks.outputs = [
      [
        `Config file path: ${localConfig}`,
        JSON.stringify({
          appId: 'cli_codex',
          brand: 'feishu',
          users: '(no logged-in users)',
        }),
      ].join('\n'),
      '',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    const privateTarget = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps: Array<{ users?: unknown }>;
    };
    expect(privateTarget.apps[0]?.users).toBeNull();
  });

  it('logs and keeps the same-app target path when repairing display-only users text cannot be written', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeRootConfig(appPaths.configFile, 'codex');
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: '(no logged-in users)',
          },
        ],
      }, null, 2),
      { mode: 0o600 },
    );
    mocks.atomicWriteFailures = [
      { path: appPaths.larkCliTargetConfigFile, err: new Error('target config readonly') },
    ];
    mocks.exitCodes = [0];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
    ]);
    expect(warn).toHaveBeenCalledWith(
      'lark-cli',
      'private-target-repair-failed',
      expect.objectContaining({ profile: 'codex' }),
    );
  });

  it('copies same-app local lark-cli users into the profile-private target before switching identity', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    const localConfig = join(root, 'local-lark-cli-config.json');
    const users = [
      {
        userOpenId: 'ou-user',
        userName: 'User Name',
        tokenRef: { source: 'keychain', id: 'user-token' },
      },
    ];
    await writeFile(
      localConfig,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            users,
          },
        ],
      }, null, 2),
      { mode: 0o600 },
    );
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    mocks.onSpawn = (callIndex) => {
      if (callIndex !== 2) return;
      writeFileSync(
        appPaths.larkCliTargetConfigFile,
        JSON.stringify({
          apps: [
            {
              appId: 'cli_codex',
              brand: 'feishu',
              defaultAs: 'bot',
              strictMode: 'bot',
              users: null,
            },
          ],
        }, null, 2),
      );
    };
    mocks.exitCodes = [0, 0, 0, 0, 0];
    mocks.outputs = [
      [
        `Config file path: ${localConfig}`,
        JSON.stringify({
          appId: 'cli_codex',
          brand: 'feishu',
          users: 'User Name (ou-user)',
        }),
      ].join('\n'),
      '',
      '',
      '',
      JSON.stringify({
        appId: 'cli_codex',
        brand: 'feishu',
        users: 'User Name (ou-user)',
      }),
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    const privateTarget = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps: Array<{ users?: unknown }>;
    };
    expect(privateTarget.apps[0]?.users).toEqual(users);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'user-default',
      localUserImport: { status: 'imported' },
    });
  });

  it('does not switch to user-default when local user display text has no structured source users', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    mocks.exitCodes = [0, 0, 0, 0, 0, 0, 0];
    mocks.outputs = [
      JSON.stringify({
        appId: 'cli_codex',
        brand: 'feishu',
        users: 'User Name (ou-user)',
      }),
      '',
      '',
      '',
      JSON.stringify({
        appId: 'cli_codex',
        brand: 'feishu',
        users: null,
      }),
      '',
      '',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'bot-only',
      localUserImport: {
        status: 'skipped-no-local-user',
        reason: 'local-user-unstructured',
      },
    });
  });

  it('keeps bot-only and continues when local user detection fails', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    mocks.exitCodes = [1, 0];
    mocks.outputs = ['no local config', ''];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    const saved = await loadRootConfig(appPaths.configFile);
    expect(saved?.profiles.codex?.larkCli).toMatchObject({
      identityPreset: 'bot-only',
      localUserImport: { status: 'failed' },
    });
  });

  it('does not mutate runtime profile lark-cli state when persisting the import result fails', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    profileConfig.larkCli = {
      identityPreset: 'user-default',
      localUserImport: {
        status: 'imported',
        attemptedAt: '2026-01-01T00:00:00.000Z',
        importedAt: '2026-01-01T00:00:00.000Z',
        reason: 'same-app-local-user',
      },
    };
    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: {},
      profiles: { codex: profileConfig },
    }, appPaths.configFile);
    mocks.atomicWriteFailures = [
      { path: appPaths.configFile, err: new Error('root config readonly') },
    ];
    mocks.exitCodes = [1, 0];
    mocks.outputs = ['local config unavailable', ''];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(profileConfig.larkCli.identityPreset).toBe('user-default');
    expect(profileConfig.larkCli.localUserImport?.reason).toBe('same-app-local-user');
    expect(warn).toHaveBeenCalledWith(
      'lark-cli',
      'profile-config-persist-failed',
      expect.objectContaining({ profile: 'codex' }),
    );
  });

  it('logs and keeps runtime profile lark-cli state when loading the root config fails during persistence', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const profileConfig = await writeRootConfig(appPaths.configFile, 'codex');
    profileConfig.larkCli = {
      identityPreset: 'user-default',
      localUserImport: {
        status: 'imported',
        attemptedAt: '2026-01-01T00:00:00.000Z',
        importedAt: '2026-01-01T00:00:00.000Z',
        reason: 'same-app-local-user',
      },
    };
    await writeFile(appPaths.configFile, '{invalid json', 'utf8');
    mocks.exitCodes = [1, 0];
    mocks.outputs = ['local config unavailable', ''];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      profileConfig,
      appPaths,
    });

    expect(profileConfig.larkCli.identityPreset).toBe('user-default');
    expect(profileConfig.larkCli.localUserImport?.reason).toBe('same-app-local-user');
    expect(warn).toHaveBeenCalledWith(
      'lark-cli',
      'profile-config-persist-failed',
      expect.objectContaining({ profile: 'codex' }),
    );
  });
});

async function writeRootConfig(configPath: string, profile: string): Promise<RootConfig['profiles'][string]> {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: bridgeConfig.accounts,
    codex: { binaryPath: 'codex' },
  });
  const rootConfig: RootConfig = {
    schemaVersion: 2,
    activeProfile: profile,
    preferences: {},
    profiles: {
      [profile]: profileConfig,
    },
  };
  await saveRootConfig(rootConfig, configPath);
  return profileConfig;
}
