import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn((_bin: string, _args: string[]) => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mocks.spawnSync,
}));

const { getServiceAdapter } = await import('../../../src/daemon/service-adapter');
const { launchAgentLabel } = await import('../../../src/daemon/paths');

const realPlatform = process.platform;
function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** launchctl subcommand + target of every call, e.g. `bootout gui/501/ai.…`. */
function launchctlCalls(): string[] {
  return mocks.spawnSync.mock.calls
    .filter(([bin]) => bin === 'launchctl')
    .map(([, args]) => args.join(' '));
}

describe('launchd autostart lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    forcePlatform('darwin');
  });

  afterAll(() => {
    forcePlatform(realPlatform);
  });

  it('stop disables the job so RunAtLoad cannot revive it at the next login', () => {
    const label = launchAgentLabel('supervisor');
    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);

    const result = adapter?.stopAndDisableAutostart() as { ok: boolean };

    expect(result.ok).toBe(true);
    // bootout alone is session-scoped — without the disable, launchd
    // re-bootstraps the plist at login and the daemon "reconnects" itself.
    expect(launchctlCalls()).toEqual([
      expect.stringMatching(new RegExp(`^bootout gui/\\d+/${label}$`)),
      expect.stringMatching(new RegExp(`^disable gui/\\d+/${label}$`)),
    ]);
  });

  it('reports the bootout failure rather than the follow-up disable', () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 3, stdout: '', stderr: 'Boot-out failed' });
    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);

    const result = adapter?.stopAndDisableAutostart() as { ok: boolean; stderr: string };

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Boot-out failed');
  });

  it('start re-enables before bootstrap so a stopped service can come back', () => {
    const label = launchAgentLabel('supervisor');
    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);

    adapter?.start();

    // Order matters: bootstrapping a disabled job leaves it loaded but dead.
    expect(launchctlCalls()).toEqual([
      expect.stringMatching(new RegExp(`^enable gui/\\d+/${label}$`)),
      expect.stringMatching(new RegExp(`^bootstrap gui/\\d+ .*${label}\\.plist$`)),
    ]);
  });

  it('disableAutostart touches only the override DB, never the running job', () => {
    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);

    adapter?.disableAutostart();

    expect(launchctlCalls()).toEqual([expect.stringMatching(/^disable gui\/\d+\//)]);
  });

  it('plain stop (used when bouncing during start) leaves autostart intact', () => {
    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);

    adapter?.stop();

    expect(launchctlCalls()).toEqual([expect.stringMatching(/^bootout /)]);
  });
});
