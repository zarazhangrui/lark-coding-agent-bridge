import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter';
import type { ProcessEntry } from '../../../src/runtime/registry';

const mocks = vi.hoisted(() => ({
  adapter: undefined as unknown as ServiceAdapter,
  getServiceAdapter: vi.fn(),
  preFlightChecks: vi.fn(),
  materializeEnvSecretForService: vi.fn(),
  resolveProfileRuntime: vi.fn(),
  readAndPrune: vi.fn(),
  checkRuntimeLock: vi.fn(),
  stopProcessEntry: vi.fn(),
  readActiveProfile: vi.fn(),
  loadRootConfig: vi.fn(),
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: mocks.getServiceAdapter,
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  materializeEnvSecretForService: mocks.materializeEnvSecretForService,
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/runtime/registry', () => ({
  readAndPrune: mocks.readAndPrune,
}));

vi.mock('../../../src/runtime/locks', () => ({
  checkRuntimeLock: mocks.checkRuntimeLock,
}));

vi.mock('../../../src/cli/commands/ps', () => ({
  stopProcessEntry: mocks.stopProcessEntry,
}));

vi.mock('../../../src/config/profile-store', () => ({
  readActiveProfile: mocks.readActiveProfile,
  loadRootConfig: mocks.loadRootConfig,
}));

vi.mock('../../../src/config/paths', () => ({
  paths: {
    rootDir: '/tmp/lark-channel-home',
    configFile: '/tmp/lark-channel-home/config.json',
    profile: 'claude',
  },
}));

vi.mock('../../../src/daemon/paths', () => ({
  daemonStdoutPath: (profile: string) => `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stdout.log`,
  daemonStderrPath: (profile: string) => `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stderr.log`,
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

const { agentDisplay, runServiceStart, runServiceStatus, runServiceUnregister } = await import(
  '../../../src/cli/commands/service'
);

describe('profile-aware service commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = {
      platformName: 'mock',
      fileExists: vi.fn(() => true),
      isRunning: vi.fn(() => false),
      servicePath: vi.fn(() => '/tmp/service'),
      install: vi.fn(async () => {}),
      start: vi.fn(() => ({ ok: true, stderr: '' })),
      stop: vi.fn(() => ({ ok: true, stderr: '' })),
      stopAndDisableAutostart: vi.fn(() => ({ ok: true, stderr: '' })),
      restart: vi.fn(() => ({ ok: true, stderr: '' })),
      waitUntilStopped: vi.fn(async () => true),
      deleteFile: vi.fn(async () => {}),
      describeStatus: vi.fn(() => ''),
      parseStatus: vi.fn(() => ({})),
    };
    mocks.getServiceAdapter.mockReturnValue(mocks.adapter);
    mocks.materializeEnvSecretForService.mockResolvedValue(false);
    mocks.stopProcessEntry.mockResolvedValue('terminated');
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'codex-dev',
      configPath: '/tmp/lark-channel-home/config.json',
      appPaths: {
        profile: 'codex-dev',
        rootDir: '/tmp/lark-channel-home',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_codex',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'codex',
      },
    });
    mocks.checkRuntimeLock.mockResolvedValue({ locked: false });
    mocks.readActiveProfile.mockResolvedValue('codex-dev');
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        'codex-dev': {},
      },
    });
  });

  it('starts the OS service for the requested profile and reports the real agent', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_codex',
          profileName: 'codex-dev',
          agentKind: 'codex',
          botName: 'Codex Bot',
        }),
      ]);

    await runServiceStart({ profile: 'codex-dev', skipCheckLarkCli: true });

    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev');
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profile: 'codex-dev',
      agent: undefined,
      workspace: undefined,
      appId: undefined,
      appSecret: undefined,
      tenant: undefined,
      allowBootstrap: true,
      handleActiveBridgeMigrationConflict: expect.any(Function),
    }));
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'codex-dev',
      allowBootstrap: false,
    });
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'codex-dev' });
    expect(mocks.preFlightChecks).toHaveBeenCalledWith({
      skipCheckLarkCli: true,
      bridgeConfig: expect.objectContaining({
        accounts: {
          app: {
            id: 'cli_codex',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'codex',
      }),
      appPaths: expect.objectContaining({
        profile: 'codex-dev',
        rootDir: '/tmp/lark-channel-home',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
      }),
      larkChannel: {
        profile: 'codex-dev',
        rootDir: '/tmp/lark-channel-home',
        configPath: '/tmp/lark-channel-home/config.json',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
      },
    });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain(
      '✓ 已启动  bot: Codex Bot (cli_codex)  agent: Codex CLI (codex)  进程: p1',
    );
  });

  it('uses materialized config for service preflight after env secret materialization', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const materializedCfg = {
      accounts: {
        app: {
          id: 'cli_codex',
          secret: {
            source: 'exec',
            provider: 'bridge',
            id: 'app-cli_codex',
          },
          tenant: 'feishu',
        },
      },
      agentKind: 'codex',
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: '/tmp/lark-channel-home/secrets-getter',
            args: [],
          },
        },
      },
    };
    mocks.materializeEnvSecretForService.mockResolvedValue(true);
    mocks.resolveProfileRuntime
      .mockResolvedValueOnce({
        profile: 'codex-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'codex-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: {
          accounts: {
            app: {
              id: 'cli_codex',
              secret: '${APP_SECRET}',
              tenant: 'feishu',
            },
          },
          agentKind: 'codex',
        },
      })
      .mockResolvedValueOnce({
        profile: 'codex-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'codex-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: materializedCfg,
      })
      .mockResolvedValueOnce({
        profile: 'codex-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'codex-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: materializedCfg,
      });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_codex',
          profileName: 'codex-dev',
          agentKind: 'codex',
          botName: 'Codex Bot',
        }),
      ]);

    await runServiceStart({ profile: 'codex-dev', skipCheckLarkCli: false });

    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'codex-dev',
      allowBootstrap: false,
    });
    expect(mocks.preFlightChecks).toHaveBeenCalledWith(expect.objectContaining({
      bridgeConfig: materializedCfg,
    }));
    expect(mocks.preFlightChecks).not.toHaveBeenCalledWith(expect.objectContaining({
      bridgeConfig: expect.objectContaining({
        accounts: {
          app: {
            id: 'cli_codex',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
      }),
    }));
  });

  it('rejects start when the requested profile is already held by a foreground run', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock.mockResolvedValue({
      locked: true,
      meta: {
        kind: 'profile',
        target: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
        profile: 'codex-dev',
        agentKind: 'codex',
        pid: 2468,
        startedAt: '2026-05-26T10:50:33.082Z',
      },
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_codex',
          profileName: 'codex-dev',
          agentKind: 'codex',
          botName: 'Codex Bot',
        }),
      ]);

    await expect(runServiceStart({ profile: 'codex-dev', skipCheckLarkCli: true })).rejects.toThrow(
      'exit:1',
    );

    expect(mocks.adapter.install).not.toHaveBeenCalled();
    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 profile 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('pid=2468');

    exit.mockRestore();
  });

  it('stops a foreground lock holder and continues service start after interactive confirmation', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const holder = {
      kind: 'profile' as const,
      target: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
      profile: 'codex-dev',
      agentKind: 'codex' as const,
      pid: 2468,
      startedAt: '2026-05-26T10:50:33.082Z',
    };
    mocks.checkRuntimeLock
      .mockResolvedValueOnce({ locked: true, meta: holder })
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ locked: false });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_codex',
          profileName: 'codex-dev',
          agentKind: 'codex',
          botName: 'Codex Bot',
        }),
      ]);

    await runServiceStart({
      profile: 'codex-dev',
      skipCheckLarkCli: true,
      confirmStopRuntimeLockProcess: async () => true,
    });

    expect(mocks.stopProcessEntry).toHaveBeenCalledWith({ pid: 2468 });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain('✓ 已停止 pid 2468');
  });

  it('rejects start when another profile already holds the same app lock', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({
        locked: true,
        meta: {
          kind: 'app',
          target: '/tmp/lark-channel-home/registry/locks/app/cli_codex.lock',
          profile: 'codex-dev',
          agentKind: 'codex',
          appId: 'cli_codex',
          pid: 2468,
          startedAt: '2026-05-26T10:50:33.085Z',
        },
      });

    await expect(runServiceStart({ profile: 'codex-dev', skipCheckLarkCli: true })).rejects.toThrow(
      'exit:1',
    );

    expect(mocks.adapter.install).not.toHaveBeenCalled();
    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 app 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('app=cli_codex');

    exit.mockRestore();
  });

  it('lets start perform first-run bootstrap without requiring a profile concept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'claude',
      appPaths: {
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/claude.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_claude',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'claude',
      },
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p2',
          pid: 12346,
          appId: 'cli_claude',
          profileName: 'claude',
          agentKind: 'claude',
          botName: 'Claude Bot',
        }),
      ]);

    await runServiceStart({
      agent: 'claude',
      workspace: '/repo',
      appId: 'cli_claude',
      appSecret: 'manual-secret',
      tenant: 'feishu',
      skipCheckLarkCli: true,
    });

    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profile: undefined,
      agent: 'claude',
      workspace: '/repo',
      appId: 'cli_claude',
      appSecret: 'manual-secret',
      tenant: 'feishu',
      allowBootstrap: true,
      handleActiveBridgeMigrationConflict: expect.any(Function),
    }));
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'claude',
      allowBootstrap: false,
    });
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('claude');
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'claude' });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
  });

  it('uses the active profile when --profile is omitted and fails if none exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (mocks.adapter.fileExists as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await runServiceStatus();
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev');

    mocks.readActiveProfile.mockResolvedValue(undefined);
    mocks.loadRootConfig.mockResolvedValue(undefined);
    await expect(runServiceStatus()).rejects.toThrow('active profile is required');
  });

  it('allows cleanup of an explicitly named service after its profile was removed', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        claude: {},
      },
    });

    await runServiceStatus({ profile: 'codex-dev' });
    await runServiceUnregister({ profile: 'codex-dev' });

    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev');
    expect(mocks.adapter.deleteFile).toHaveBeenCalled();
    expect(lines).toContain('✓ 已清除后台运行注册');
    expect(lines).toContain('  (配置 / 日志 / 会话保留在 /tmp/lark-channel-home)');
  });

  it('displays pi processes with their own id and display name', () => {
    expect(agentDisplay('pi')).toEqual({ id: 'pi', displayName: 'Pi' });
    expect(agentDisplay('codex')).toEqual({ id: 'codex', displayName: 'Codex CLI' });
    expect(agentDisplay('claude')).toEqual({ id: 'claude', displayName: 'Claude Code' });
  });
});

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'claude',
    agentKind: 'claude',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    ...overrides,
  };
}
