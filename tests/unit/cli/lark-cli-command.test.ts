import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preFlightChecks: vi.fn(),
  resolveProfileRuntime: vi.fn(),
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return {
    ...actual,
    spawnProcess: mocks.spawnProcess,
  };
});

const { runProfileLarkCli } = await import('../../../src/cli/commands/lark-cli');

describe('profile-scoped lark-cli command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'codex-dev',
      configPath: '/tmp/lark-channel/config.json',
      cfg: { accounts: { app: { id: 'cli_bot', secret: 'secret', tenant: 'feishu' } } },
      profileConfig: { mode: 'personal', agentKind: 'codex' },
      appPaths: {
        rootDir: '/tmp/lark-channel',
        profile: 'codex-dev',
        larkCliConfigDir: '/tmp/lark-channel/profiles/codex-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel/profiles/codex-dev/lark-cli-source/config.json',
      },
    });
  });

  it('runs lark-cli inside the selected private profile environment', async () => {
    const child = new EventEmitter();
    mocks.spawnProcess.mockReturnValue(child);

    const result = runProfileLarkCli(
      ['im', '+chat-search', '--query', 'Museon AI All Hands'],
      { profile: 'codex-dev' },
    );
    await vi.waitFor(() => expect(mocks.spawnProcess).toHaveBeenCalledOnce());
    child.emit('exit', 0, null);

    await expect(result).resolves.toBe(0);
    expect(mocks.resolveProfileRuntime).toHaveBeenCalledWith({
      config: undefined,
      profile: 'codex-dev',
      allowBootstrap: false,
    });
    expect(mocks.preFlightChecks).toHaveBeenCalledWith(expect.objectContaining({
      bridgeConfig: expect.objectContaining({ accounts: expect.any(Object) }),
      larkChannel: {
        profile: 'codex-dev',
        rootDir: '/tmp/lark-channel',
        configPath: '/tmp/lark-channel/config.json',
        larkCliConfigDir: '/tmp/lark-channel/profiles/codex-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel/profiles/codex-dev/lark-cli-source/config.json',
      },
    }));
    expect(mocks.spawnProcess).toHaveBeenCalledWith(
      'lark-cli',
      ['im', '+chat-search', '--query', 'Museon AI All Hands'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({
          LARK_CHANNEL: '1',
          LARK_CHANNEL_PROFILE: 'codex-dev',
          LARK_CHANNEL_HOME: '/tmp/lark-channel',
          LARK_CHANNEL_CONFIG: '/tmp/lark-channel/profiles/codex-dev/lark-cli-source/config.json',
          LARKSUITE_CLI_CONFIG_DIR: '/tmp/lark-channel/profiles/codex-dev/lark-cli',
        }),
      }),
    );
  });

  it('rejects an empty passthrough command', async () => {
    await expect(runProfileLarkCli([], { profile: 'codex-dev' }))
      .rejects.toThrow('lark-cli arguments are required');
    expect(mocks.resolveProfileRuntime).not.toHaveBeenCalled();
  });
});
