import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeLockConflictError, type RuntimeLockMeta } from '../../../src/runtime/locks';

const mocks = vi.hoisted(() => ({
  resolveProfileRuntime: vi.fn(),
  preFlightChecks: vi.fn(),
  withProfileAndAppLocks: vi.fn(),
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

vi.mock('../../../src/runtime/locks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/locks')>();
  return {
    ...actual,
    withProfileAndAppLocks: mocks.withProfileAndAppLocks,
  };
});

vi.mock('../../../src/agent/codex/adapter', () => ({
  CodexAdapter: class {
    id = 'codex';
    displayName = 'Codex CLI';
    async isAvailable() {
      return true;
    }
  },
}));

vi.mock('../../../src/agent/claude/sdk-adapter', () => ({
  ClaudeSdkAdapter: class {
    id = 'claude';
    displayName = 'Claude Code';
    async isAvailable() {
      return true;
    }
  },
}));

const { runStart } = await import('../../../src/cli/commands/start');

describe('run runtime lock conflict handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'codex',
      configPath: '/tmp/lark-channel-home/config.json',
      appPaths: {
        profile: 'codex',
        rootDir: '/tmp/lark-channel-home',
        profileDir: '/tmp/lark-channel-home/profiles/codex',
        logsDir: '/tmp/lark-channel-home/profiles/codex/logs',
        mediaDir: '/tmp/lark-channel-home/profiles/codex/media',
        sessionsFile: '/tmp/lark-channel-home/profiles/codex/sessions.json',
        workspacesFile: '/tmp/lark-channel-home/profiles/codex/workspaces.json',
        userRegistryFile: '/tmp/lark-channel-home/registry/processes.json',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/codex/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/codex/lark-cli-source/config.json',
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex.lock',
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
      profileConfig: {
        agentKind: 'codex',
        accounts: {
          app: {
            id: 'cli_codex',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        codex: {
          binaryPath: '/usr/local/bin/codex',
          realpath: '/usr/local/bin/codex',
          version: 'codex 1.2.3',
          sha256: '0'.repeat(64),
        },
        sandbox: { defaultMode: 'danger-full-access', maxMode: 'danger-full-access' },
        workspaces: {},
      },
    });
  });

  it('stops the current profile lock holder and retries foreground run after confirmation', async () => {
    const holder: RuntimeLockMeta = {
      kind: 'profile',
      target: '/tmp/lark-channel-home/registry/locks/profile/codex.lock',
      profile: 'codex',
      agentKind: 'codex',
      pid: 83130,
      startedAt: '2026-05-28T12:50:39.072Z',
    };
    mocks.withProfileAndAppLocks
      .mockRejectedValueOnce(new RuntimeLockConflictError('profile', holder.target, holder, new Error('locked')))
      .mockResolvedValueOnce(undefined);
    const stopped: RuntimeLockMeta[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runStart({
        profile: 'codex',
        skipCheckLarkCli: true,
        confirmStopRuntimeLockProcess: async () => true,
        stopRuntimeLockProcess: async (meta) => {
          stopped.push(meta);
          return 'terminated' as const;
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.withProfileAndAppLocks).toHaveBeenCalledTimes(2);
    expect(stopped).toEqual([holder]);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
