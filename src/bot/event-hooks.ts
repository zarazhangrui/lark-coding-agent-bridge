import type { LarkChannel } from '@larksuite/channel';
import type {
  EventHookAdapter,
  EventHookContext,
  EventHookHandler,
} from '../core/event-hooks';
import { log } from '../core/logger';

interface EventDispatcherLike {
  handles?: {
    has(eventType: string): boolean;
    get?(eventType: string): unknown;
  };
  register(handles: Record<string, (event: unknown) => unknown>): unknown;
}

interface HookableChannel {
  dispatcher?: EventDispatcherLike;
  registerDispatcherHandlers?: () => void;
}

/**
 * Install custom handlers at the channel's dispatcher-registration boundary.
 *
 * LarkChannel creates an EventDispatcher (which already owns `app_ticket`) in
 * its constructor, then registers its normalized built-in handlers inside
 * `doConnect()`, immediately before starting the WebSocket. Hook handlers must
 * be added after those built-ins so the dispatcher's actual key set is the
 * source of truth: every occupied key is rejected, including SDK internals and
 * future channel events this bridge does not know about.
 *
 * @larksuite/channel does not expose this boundary publicly yet, so this is a
 * feature-detected compatibility shim. If the private shape changes, hooks are
 * disabled rather than risking an overwrite.
 */
export function installEventHookHandlers(
  channel: LarkChannel,
  adapter: EventHookAdapter | undefined,
  context: Omit<EventHookContext, 'channel' | 'eventType'>,
): void {
  const handlers = adapter?.handlers;
  if (!handlers) return;

  const hookable = channel as unknown as HookableChannel;
  const dispatcher = hookable.dispatcher;
  const registerChannelHandlers = hookable.registerDispatcherHandlers;
  if (
    !dispatcher ||
    typeof dispatcher.register !== 'function' ||
    !dispatcher.handles ||
    typeof dispatcher.handles.has !== 'function' ||
    typeof registerChannelHandlers !== 'function'
  ) {
    log.warn('eventHook', 'channel-hook-point-unavailable');
    return;
  }

  let installed = false;
  hookable.registerDispatcherHandlers = () => {
    registerChannelHandlers.call(channel);
    if (installed) return;
    installed = true;
    registerAvailableHandlers(channel, dispatcher, handlers, context);
  };
}

function registerAvailableHandlers(
  channel: LarkChannel,
  dispatcher: EventDispatcherLike,
  handlers: Record<string, EventHookHandler>,
  context: Omit<EventHookContext, 'channel' | 'eventType'>,
): void {
  const registry = dispatcher.handles;
  if (!registry) return;

  const handles: Record<string, (event: unknown) => Promise<void>> = {};
  for (const [eventType, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') {
      log.warn('eventHook', 'skip-invalid-handler', { eventType });
      continue;
    }
    if (registry.has(eventType)) {
      log.warn('eventHook', 'skip-reserved', { eventType });
      continue;
    }
    handles[eventType] = wrapEventHookHandler(channel, eventType, handler, context);
  }

  const events = Object.keys(handles);
  if (events.length === 0) return;

  try {
    dispatcher.register(handles);
    const registered = typeof registry.get === 'function'
      ? events.filter((eventType) => registry.get?.(eventType) === handles[eventType])
      : events;
    const missing = events.filter((eventType) => !registered.includes(eventType));
    if (missing.length > 0) {
      log.warn('eventHook', 'registration-not-installed', { events: missing });
    }
    if (registered.length > 0) {
      log.info('eventHook', 'registered', { events: registered });
    }
  } catch (err) {
    log.fail('eventHook', err, { step: 'register', events });
  }
}

function wrapEventHookHandler(
  channel: LarkChannel,
  eventType: string,
  handler: EventHookHandler,
  context: Omit<EventHookContext, 'channel' | 'eventType'>,
): (event: unknown) => Promise<void> {
  return async (event: unknown) => {
    try {
      await handler(event, {
        ...context,
        eventType,
        channel,
      });
    } catch (err) {
      log.fail('eventHook', err, { eventType });
    }
  };
}
