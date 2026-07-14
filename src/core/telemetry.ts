import type { LogContext, LogFields } from './logger';
import { normalizeModuleSpecifier } from './module-specifier';

/**
 * Optional telemetry hook.
 *
 * The bridge itself ships **no** telemetry: by default this module is inert
 * (a noop adapter), pulls in zero dependencies, and makes zero network calls.
 *
 * An operator who wants monitoring points `LARK_CHANNEL_TELEMETRY_MODULE` at a
 * package that default-exports (or exposes `createAdapter`) an `AdapterFactory`.
 * That package — not this repo — owns the vendor SDK, endpoints, and keys.
 * See README "Optional telemetry".
 */

/** A single structured event — mirrors what `logger.emit` produces. */
export interface TelemetryEvent {
  level: 'info' | 'warn' | 'error';
  phase: string;
  event: string;
  fields: LogFields;
  ctx: LogContext;
  /** ISO-8601 timestamp, same value written to the JSON log line. */
  ts: string;
}

/** Sink an external package provides to receive bridge telemetry. */
export interface TelemetryAdapter {
  /** Called for every `log.*` call (info / warn / error). */
  emit(event: TelemetryEvent): void;
  /** Capture an error/exception with its stack. */
  recordError(err: unknown, ctx?: Record<string, unknown>): void;
  /** Record a numeric metric with optional string tags. */
  recordMetric(name: string, value: number, tags?: Record<string, string>): void;
  /** Flush buffered events; `timeoutMs` bounds the wait. Optional. */
  flush?(timeoutMs?: number): Promise<void> | void;
  /** Release resources on shutdown. Optional. */
  close?(): Promise<void> | void;
}

/** Runtime metadata handed to the factory when the adapter is loaded. */
export interface AdapterMeta {
  version: string;
  appId?: string;
  tenant?: string;
  /** Host machine identifier (e.g. `os.hostname()`). Useful as a stable
   *  `deviceId` for the telemetry sink — survives process restarts. */
  hostname?: string;
}

/** The shape an external module must default-export (or expose as `createAdapter`). */
export type AdapterFactory = (meta: AdapterMeta) => TelemetryAdapter;

const noop: TelemetryAdapter = {
  emit() {},
  recordError() {},
  recordMetric() {},
  flush() {},
  close() {},
};

let active: TelemetryAdapter = noop;
let methodWarned = false;

// telemetry's own diagnostics go straight to the console: importing the logger
// here would create a cycle (logger imports telemetry), and these lines are
// rare enough that a plain console.warn is fine.
function diag(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(`⚠ [telemetry.${event}] ${JSON.stringify(fields)}`);
}

function warnOnce(event: string, fields: Record<string, unknown>): void {
  if (methodWarned) return;
  methodWarned = true;
  diag(event, fields);
}

function bound<T>(fn: T | undefined, ctx: unknown): T | undefined {
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(ctx) as T : undefined;
}

/**
 * Wrap every adapter method in try/catch so a throwing — or just slow and
 * sloppy — adapter can never break the host. Errors are swallowed with a
 * one-time diagnostic. Missing required methods fall back to noop.
 */
function wrapSafe(adapter: TelemetryAdapter): TelemetryAdapter {
  const safe = <A extends unknown[], R>(
    fn: ((...args: A) => R) | undefined,
  ): ((...args: A) => R | undefined) | undefined => {
    if (!fn) return undefined;
    return (...args: A) => {
      try {
        return fn(...args);
      } catch (err) {
        warnOnce('method_threw', {
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };
  };
  return {
    emit: safe(bound(adapter.emit, adapter)) ?? noop.emit,
    recordError: safe(bound(adapter.recordError, adapter)) ?? noop.recordError,
    recordMetric: safe(bound(adapter.recordMetric, adapter)) ?? noop.recordMetric,
    flush: safe(bound(adapter.flush, adapter)),
    close: safe(bound(adapter.close, adapter)),
  };
}

/**
 * Load the optional telemetry adapter named by `LARK_CHANNEL_TELEMETRY_MODULE`.
 *
 * - No env set → stay noop (the open-source default: zero deps, zero egress).
 * - Module missing / not a factory / throws → log a diagnostic and stay noop.
 *
 * Never throws: a broken telemetry module must not stop the bridge starting.
 */
export async function loadTelemetryAdapter(meta: AdapterMeta): Promise<void> {
  const mod = process.env.LARK_CHANNEL_TELEMETRY_MODULE;
  if (!mod) return;
  try {
    const imported = (await import(normalizeModuleSpecifier(mod))) as {
      default?: unknown;
      createAdapter?: unknown;
    };
    const factory = (imported.default ?? imported.createAdapter) as
      | AdapterFactory
      | undefined;
    if (typeof factory !== 'function') {
      diag('bad_module', { module: mod });
      return;
    }
    const adapter = factory(meta);
    if (!adapter || typeof adapter.emit !== 'function') {
      diag('bad_adapter', { module: mod });
      return;
    }
    active = wrapSafe(adapter);
  } catch (err) {
    diag('load_fail', {
      module: mod,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The active adapter — noop until/unless `loadTelemetryAdapter` installs one. */
export function telemetry(): TelemetryAdapter {
  return active;
}
