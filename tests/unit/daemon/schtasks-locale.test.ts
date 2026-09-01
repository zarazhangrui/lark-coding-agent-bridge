import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn((_bin: string, _args: string[]) => ({ status: 0, stdout: '', stderr: '' })),
  rmSync: vi.fn(),
  readAndPrune: vi.fn((): Array<Record<string, unknown>> => []),
  unregisterSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mocks.spawnSync,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  rmSync: mocks.rmSync,
}));

vi.mock('../../../src/runtime/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/runtime/registry')>()),
  readAndPrune: mocks.readAndPrune,
  unregisterSync: mocks.unregisterSync,
}));

const { getServiceAdapter } = await import('../../../src/daemon/service-adapter');
const schtasks = await import('../../../src/daemon/schtasks');

const realPlatform = process.platform;
function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * zh-CN `schtasks /Query /V /FO LIST` output for a running task. The labels
 * are localized and arrive as U+FFFD mojibake after UTF-8 decoding, so they
 * cannot (and must not) be matched; the values are plain ASCII.
 */
const zhRunningListing = [
  '????: \\',
  '?? LarkChannelBridge.Bot.claude',
  '??: ??????', // Status: Running (localized)
  '??????: 2026/8/20 19:00:20',
  '????: 267009', // Last Result: SCHED_S_TASK_RUNNING
  '????: ???', // Scheduled Task State: Enabled
].join('\r\n');

/** Terminated / disabled task: result is a non-running sentinel. */
const zhIdleListing = '????: 267014\r\n????: ???\r\n';

function queryStdout(text: string): void {
  mocks.spawnSync.mockImplementation((bin: string) =>
    bin === 'schtasks'
      ? { status: 0, stdout: text, stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
  );
}

describe('schtasks on localized (non-English) Windows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forcePlatform('win32');
    mocks.readAndPrune.mockReturnValue([]);
  });

  afterAll(() => {
    forcePlatform(realPlatform);
  });

  it('isTaskRunning detects a running task via the 267009 sentinel when the Status label is localized', () => {
    queryStdout(zhRunningListing);
    expect(schtasks.isTaskRunning('claude')).toBe(true);
  });

  it('isTaskRunning still matches English listings', () => {
    queryStdout('Status: Running\r\nLast Result: 267009\r\n');
    expect(schtasks.isTaskRunning('claude')).toBe(true);
  });

  it('isTaskRunning does not treat a stopped task as running', () => {
    queryStdout(zhIdleListing);
    expect(schtasks.isTaskRunning('claude')).toBe(false);
  });

  it('parseStatus falls back to the registry pid when the listing has no Process ID line', () => {
    queryStdout(zhRunningListing);
    mocks.readAndPrune.mockReturnValue([
      { id: '0b43', pid: 21840, profileName: 'claude', appId: 'cli_x' },
    ]);
    const adapter = getServiceAdapter('claude', ['run']);
    const parsed = adapter?.parseStatus(adapter.describeStatus());
    expect(parsed?.pid).toBe('21840');
  });

  it('parseStatus does not report a registry pid while the task is not running', () => {
    queryStdout(zhIdleListing);
    mocks.readAndPrune.mockReturnValue([
      { id: '0b43', pid: 21840, profileName: 'claude', appId: 'cli_x' },
    ]);
    const adapter = getServiceAdapter('claude', ['run']);
    const parsed = adapter?.parseStatus(adapter.describeStatus());
    expect(parsed?.pid).toBeUndefined();
  });

  it('endTask kills the launcher-spawned tree and clears its registry entry and locks', () => {
    queryStdout('');
    mocks.readAndPrune.mockReturnValue([
      { id: '0b43', pid: 21840, profileName: 'claude', appId: 'cli_x' },
    ]);
    schtasks.endTask('claude');

    const kill = mocks.spawnSync.mock.calls.find(([bin]) => bin === 'taskkill');
    expect(kill?.[1]).toEqual(['/PID', '21840', '/T', '/F']);
    expect(mocks.unregisterSync).toHaveBeenCalledWith('0b43');
    // lock file + .meta.json + the proper-lockfile mutex dir, for both
    // the profile lock and the app lock.
    const lockRemovals = mocks.rmSync.mock.calls.filter(([p]) => String(p).includes('.lock'));
    expect(lockRemovals.length).toBe(6);
  });

  it('endTask leaves state untouched when the profile has no registry entry', () => {
    queryStdout('');
    mocks.readAndPrune.mockReturnValue([]);
    schtasks.endTask('claude');
    expect(mocks.unregisterSync).not.toHaveBeenCalled();
    expect(mocks.spawnSync.mock.calls.find(([bin]) => bin === 'taskkill')).toBeUndefined();
  });
});
