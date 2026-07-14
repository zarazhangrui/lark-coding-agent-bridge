// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';

// Optional raw event hooks (see README "Optional event hooks"). Types let an
// external hook package implement custom EventKey handlers.
export type {
  EventHookAdapter,
  EventHookContext,
  EventHookFactory,
  EventHookHandler,
  EventHookMeta,
} from './core/event-hooks';
export { reportMetric, reportError } from './core/logger';
