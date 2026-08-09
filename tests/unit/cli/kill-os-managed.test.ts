import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter';
import type { ProcessEntry } from '../../../src/runtime/registry';

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  readAndPrune: vi.fn(() => []),
  isAlive: vi.fn(() => false),
  getServiceAdapter: vi.fn(),
}));

vi.mock('../../../src/runtime/registry', () => ({
  resolveTarget: mocks.resolveTarget,
  readAndPrune: mocks.readAndPrune,
  isAlive: mocks.isAlive,
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: mocks.getServiceAdapter,
}));

vi.mock('../../../src/daemon/paths', () => ({
  SUPERVISOR_SERVICE_ID: 'supervisor',
}));

const { runKillCli } = await import('../../../src/cli/commands/ps');

describe('kill on OS-managed processes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAlive.mockReturnValue(false);
    mocks.resolveTarget.mockReturnValue(entry());
    mocks.getServiceAdapter.mockReturnValue(undefined);
  });

  it('refuses to SIGTERM a process the service manager owns and points at `stop`', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    // The supervisor service is loaded and its pid IS this registry entry's pid
    // (every profile it hosts runs in that one process).
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'supervisor' ? adapter({ pid: '4242' }) : undefined,
    );

    await expect(runKillCli('4a93')).rejects.toThrow('exit:1');

    // Killing it would only hand the pid back to launchd's KeepAlive.
    expect(kill).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('由 launchd (macOS) 托管');
    expect(errors.join('\n')).toContain('lark-channel-bridge stop --web-ui');
    expect(errors.join('\n')).toContain('lark-channel-bridge restart --web-ui');

    exit.mockRestore();
    kill.mockRestore();
  });

  it('names the per-profile service when that is what owns the pid', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'codex-dev' ? adapter({ pid: '4242' }) : undefined,
    );

    await expect(runKillCli('4a93')).rejects.toThrow('exit:1');

    expect(errors.join('\n')).toContain('lark-channel-bridge stop --profile codex-dev');

    exit.mockRestore();
  });

  it('still kills a foreground process no service manager claims', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    // Service is loaded but on a different pid — this entry is a plain
    // `bridge run` in someone's terminal.
    mocks.getServiceAdapter.mockReturnValue(adapter({ pid: '9999' }));

    await runKillCli('4a93');

    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(lines).toContain('✓ 已关闭 bot 4a93。');

    kill.mockRestore();
  });
});

function entry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    id: '4a93',
    pid: 4242,
    appId: 'cli_codex',
    tenant: 'feishu',
    profileName: 'codex-dev',
    agentKind: 'codex',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.6.1',
    ...overrides,
  };
}

function adapter({ pid }: { pid: string }): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: () => true,
    isRunning: () => true,
    servicePath: () => '/tmp/service.plist',
    install: async () => {},
    start: () => ({ ok: true, stderr: '' }),
    stop: () => ({ ok: true, stderr: '' }),
    stopAndDisableAutostart: () => ({ ok: true, stderr: '' }),
    disableAutostart: () => ({ ok: true, stderr: '' }),
    restart: () => ({ ok: true, stderr: '' }),
    waitUntilStopped: async () => true,
    deleteFile: async () => {},
    describeStatus: () => `pid = ${pid}`,
    parseStatus: (text: string) => ({ pid: text.match(/pid\s*=\s*(\d+)/)?.[1] }),
  };
}
