import type { LarkChannel } from '@larksuite/channel';
import { log } from './logger';
import { normalizeModuleSpecifier } from './module-specifier';

/**
 * Optional raw Lark event hooks.
 *
 * The bridge has built-in handlers for message/card/reaction/comment events.
 * Operators can point `LARK_CHANNEL_EVENT_HOOK_MODULE` at an external module to
 * add handlers for other EventKeys on the same long-connection dispatcher.
 */

export interface EventHookMeta {
  version: string;
  appId?: string;
  tenant?: string;
  profile?: string;
  configPath?: string;
  hostname?: string;
}

export interface EventHookContext extends EventHookMeta {
  eventType: string;
  channel: LarkChannel;
}

export type EventHookHandler = (
  event: unknown,
  context: EventHookContext,
) => void | Promise<void>;

export interface EventHookAdapter {
  /** EventKey -> raw event handler. */
  handlers?: Record<string, EventHookHandler>;
  /** Release resources on bridge shutdown. Optional. */
  close?(): void | Promise<void>;
}

/**
 * Create the adapter for one bridge instance.
 *
 * The bridge can briefly overlap old and replacement connections during
 * reconnect, so every invocation must return a fresh, independently closeable
 * adapter. Returning a cached singleton is unsupported.
 */
export type EventHookFactory = (
  meta: EventHookMeta,
) => EventHookAdapter | Promise<EventHookAdapter>;

function diag(event: string, fields: Record<string, unknown>): void {
  log.warn('eventHook', event, fields);
}

/**
 * Load the optional event hook adapter named by
 * `LARK_CHANNEL_EVENT_HOOK_MODULE`.
 *
 * Missing/bad modules degrade to undefined: a custom hook must never stop the
 * bridge from starting.
 */
export async function loadEventHookAdapter(
  meta: EventHookMeta,
): Promise<EventHookAdapter | undefined> {
  const mod = process.env.LARK_CHANNEL_EVENT_HOOK_MODULE;
  if (!mod) return undefined;
  try {
    const imported = (await import(normalizeModuleSpecifier(mod))) as {
      default?: unknown;
      createEventHooks?: unknown;
    };
    const factory = (imported.default ?? imported.createEventHooks) as
      | EventHookFactory
      | undefined;
    if (typeof factory !== 'function') {
      diag('bad_module', { module: mod });
      return undefined;
    }
    const adapter = await factory(meta);
    if (!adapter || typeof adapter !== 'object') {
      diag('bad_adapter', { module: mod });
      return undefined;
    }
    if (adapter.handlers !== undefined && !isRecord(adapter.handlers)) {
      diag('bad_handlers', { module: mod });
      return undefined;
    }
    if (adapter.close !== undefined && typeof adapter.close !== 'function') {
      diag('bad_close', { module: mod });
      return undefined;
    }
    return adapter;
  } catch (err) {
    diag('load_fail', {
      module: mod,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, EventHookHandler> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
