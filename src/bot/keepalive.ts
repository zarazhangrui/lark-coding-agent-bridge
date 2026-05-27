import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * App-level keepalive loop. Defense-in-depth against silent SDK / network
 * issues that the SDK's internal ping watchdog might miss.
 *
 * Patterns borrowed from notebook bot's `auto_reconnect`:
 *
 *  1. 15s setInterval — independent of SDK's pingInterval (server-pushed,
 *     typically 30-60s). We catch issues earlier and from a different angle.
 *
 *  2. Wake-up detection — if the timer was skipped for > SLEEP_DETECT_MS, the
 *     machine likely slept (laptop lid / hibernate / suspend). Reset counters
 *     and bail out for this tick: don't trust state captured pre-sleep.
 *
 *  3. Timer storm guard — when machine wakes, multiple intervals can fire
 *     back-to-back. If less than TIMER_STORM_GUARD_MS since last tick, skip.
 *
 *  4. HTTP probe — before force-reconnecting, hit the Feishu domain over HTTP.
 *     If even HTTP can't reach, it's a network-level outage, not a WS issue,
 *     and force-reconnect won't help. Avoid log spam.
 *
 *  5. Counter-based debounce — only force-reconnect after DEAD_THRESHOLD
 *     consecutive ticks confirm WS is not connected. Defends against
 *     transient state-read races during reconnect.
 */

const KEEPALIVE_INTERVAL_MS = 15_000;
const SLEEP_DETECT_MS = 30_000;
const TIMER_STORM_GUARD_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;
const DEAD_THRESHOLD = 3;
const NETWORK_DOWN_LOG_EVERY = 20; // log roughly every 5min while network is down

// Exponential backoff for force-reconnect. After repeated force-reconnect
// cycles (each cycle = DEAD_THRESHOLD consecutive ws-stuck ticks), wait
// progressively longer before triggering the next one. This prevents a
// reconnect storm from hammering the Feishu WS gateway.
const FORCE_RECONNECT_BACKOFF_BASE_MS = 30_000; // 30s base
const FORCE_RECONNECT_BACKOFF_MAX_MS = 300_000; // 5min cap

export interface KeepaliveDeps {
  channel: LarkChannel;
  /** HTTP probe target, typically `https://open.feishu.cn` or lark equivalent. */
  domain: string;
  /** Force-reconnect callback. Bridge uses `controls.restart`. */
  forceReconnect: () => Promise<void>;
}

export interface KeepaliveHandle {
  stop(): void;
}

export function startKeepalive(deps: KeepaliveDeps): KeepaliveHandle {
  const { channel, domain, forceReconnect } = deps;

  let lastTick = 0;
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let forceReconnectCount = 0;
  let lastForceReconnectAt = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = Date.now();
    const sinceLast = lastTick > 0 ? now - lastTick : 0;

    // (3) Timer storm — multiple intervals firing at once on wake-up.
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) {
      return;
    }
    // (2) Sleep detection — machine likely just woke from sleep.
    if (sinceLast > SLEEP_DETECT_MS) {
      log.info('keepalive', 'wake-up', { sleptMs: sinceLast });
      consecutiveDown = 0;
      networkDownTicks = 0;
      lastTick = now;
      return;
    }
    lastTick = now;

    const status = channel.getConnectionStatus();
    if (!status) {
      // Channel not initialized yet (pre-connect). Skip.
      return;
    }
    if (status.state === 'connected') {
      if (consecutiveDown > 0) {
        log.info('keepalive', 'recovered', { afterTicks: consecutiveDown });
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      forceReconnectCount = 0;
      return;
    }

    // (4) Probe whether the network can even reach Feishu. If not, it's not
    //     a WS-level problem and force-reconnect won't help.
    const reachable = await httpProbe(domain);
    if (!reachable) {
      networkDownTicks++;
      // Rate-limit log: first hit + every NETWORK_DOWN_LOG_EVERY ticks.
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        log.warn('network', 'unreachable', { domain, networkDownTicks });
      }
      // Reset WS-side counter — we're blocked by network, not WS.
      consecutiveDown = 0;
      return;
    }
    if (networkDownTicks > 0) {
      log.info('network', 'reachable-again', { afterTicks: networkDownTicks });
      networkDownTicks = 0;
    }

    // Network reachable but WS not connected → WS is stuck.
    consecutiveDown++;
    log.warn('keepalive', 'ws-stuck', {
      state: status.state,
      reconnectAttempts: status.reconnectAttempts,
      consecutiveDown,
    });

    // (5) Counter-based debounce — wait for DEAD_THRESHOLD ticks before
    //     force-reconnecting, with exponential backoff between consecutive
    //     force-reconnect cycles to avoid reconnection storms.
    if (consecutiveDown >= DEAD_THRESHOLD) {
      consecutiveDown = 0;
      forceReconnectCount++;
      const backoffMs = Math.min(
        FORCE_RECONNECT_BACKOFF_BASE_MS * Math.pow(2, forceReconnectCount - 1),
        FORCE_RECONNECT_BACKOFF_MAX_MS,
      );
      const sinceLastForce =
        lastForceReconnectAt > 0 ? Date.now() - lastForceReconnectAt : Infinity;
      if (sinceLastForce < backoffMs) {
        log.warn('keepalive', 'force-reconnect-skipped', {
          state: status.state,
          forceReconnectCount,
          backoffMs,
          waitRemainingMs: backoffMs - sinceLastForce,
        });
        return;
      }
      log.warn('keepalive', 'force-reconnect', {
        state: status.state,
        forceReconnectCount,
        backoffMs,
      });
      lastForceReconnectAt = Date.now();
      try {
        await forceReconnect();
      } catch (err) {
        log.fail('keepalive', err, { step: 'force-reconnect' });
      }
    }
  };

  // (1) 15s independent timer, untied from SDK's internal ping cadence.
  const timer = setInterval(() => {
    void tick().catch((err) => log.fail('keepalive', err, { step: 'tick' }));
  }, KEEPALIVE_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function httpProbe(domain: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
      // HEAD on root is cheap and harmless; any HTTP response counts as "reachable".
      const res = await fetch(domain, { method: 'HEAD', signal: ctrl.signal });
      // Even a 4xx/5xx means the host answered → reachable.
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
