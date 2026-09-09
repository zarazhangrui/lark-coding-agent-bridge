import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepalive } from '../../../src/bot/keepalive.js';

function reconnectingChannel() {
  return {
    getConnectionStatus: () => ({ state: 'reconnecting', reconnectAttempts: 1 }),
  };
}

describe('bridge keepalive recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('rebuilds a still-disconnected WebSocket as soon as Feishu becomes reachable again', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => undefined);
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const keepalive = startKeepalive({
      channel: reconnectingChannel() as never,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      probe,
      timing: { intervalMs: 1_000, timerStormGuardMs: 0, sleepDetectMs: 10_000, deadThreshold: 99 },
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(forceReconnect).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('rebuilds a reachable WebSocket that stays disconnected past the hard deadline', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => undefined);
    const keepalive = startKeepalive({
      channel: reconnectingChannel() as never,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      probe: async () => true,
      timing: {
        intervalMs: 1_000,
        timerStormGuardMs: 0,
        sleepDetectMs: 10_000,
        deadThreshold: 99,
        hardReconnectMs: 3_000,
      },
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(forceReconnect).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('does not let ordinary retry attempts postpone the hard deadline', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => undefined);
    const keepalive = startKeepalive({
      channel: reconnectingChannel() as never,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      probe: async () => true,
      timing: {
        intervalMs: 1_000,
        timerStormGuardMs: 0,
        sleepDetectMs: 10_000,
        deadThreshold: 1,
        hardReconnectMs: 3_000,
      },
    });

    await vi.advanceTimersByTimeAsync(4_000);

    // Three regular retries (t=1,2,3), then one deadline escalation (t=4).
    expect(forceReconnect).toHaveBeenCalledTimes(4);
    keepalive.stop();
  });

  it('does not pile up restart attempts while a restart is still running', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const forceReconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const keepalive = startKeepalive({
      channel: reconnectingChannel() as never,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      probe: async () => true,
      timing: {
        intervalMs: 1_000,
        timerStormGuardMs: 0,
        sleepDetectMs: 10_000,
        deadThreshold: 1,
        hardReconnectMs: 90_000,
      },
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(forceReconnect).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    keepalive.stop();
  });
});
