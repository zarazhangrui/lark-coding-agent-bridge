type PresentationMode = 'clean' | 'progress' | 'debug';

type AgentEvent = {
    type: 'system';
    sessionId?: string;
    threadId?: string;
    cwd?: string;
    model?: string;
} | {
    type: 'text';
    delta: string;
} | {
    type: 'thinking';
    delta: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    id: string;
    output: string;
    isError: boolean;
} | {
    type: 'usage';
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
} | {
    type: 'done';
    sessionId?: string;
    threadId?: string;
    terminationReason: 'normal' | 'interrupted' | 'timeout';
} | {
    type: 'error';
    message: string;
    terminationReason: 'failed' | 'interrupted' | 'timeout';
};

type ToolStatus = 'running' | 'done' | 'error';
interface ToolEntry {
    id: string;
    name: string;
    input: unknown;
    status: ToolStatus;
    output?: string;
}
type Block = {
    kind: 'text';
    content: string;
    streaming: boolean;
} | {
    kind: 'tool';
    tool: ToolEntry;
};
type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';
interface RunState {
    blocks: Block[];
    reasoning: {
        content: string;
        active: boolean;
    };
    footer: FooterStatus;
    terminal: Terminal;
    errorMsg?: string;
    /** Set when terminal === 'idle_timeout' — how long claude was idle before
     * the watchdog gave up (so the message can say "N 分钟无响应"). */
    idleTimeoutMinutes?: number;
}
declare const initialState: RunState;
declare function reduce(state: RunState, evt: AgentEvent): RunState;
declare function markInterrupted(state: RunState): RunState;
declare function finalizeIfRunning(state: RunState): RunState;

interface RunCardRenderOptions {
    signCallback?: (action: string) => string;
    presentationMode?: PresentationMode;
}
declare function renderCard(state: RunState, options?: RunCardRenderOptions): object;

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
interface TextRenderOptions {
    presentationMode?: PresentationMode;
}
declare function renderText(state: RunState, options?: TextRenderOptions): string;

/**
 * Structured logger.
 *
 * Two destinations on every call:
 *  1. JSON line into the active profile logs directory — the durable
 *     record `/doctor` greps over.
 *  2. Compact human-readable line on stdout/stderr — for live tailing in dev.
 *
 * Per-message context (traceId, chatId, msgId) is propagated automatically
 * via AsyncLocalStorage; call `withTrace()` once at the entry point and any
 * downstream `log.*` calls pick up the same fields.
 */
interface LogContext {
    traceId?: string;
    chatId?: string;
    msgId?: string;
}
type LogFields = Record<string, unknown>;
declare function reportMetric(name: string, value: number, tags?: Record<string, string>): void;
declare function reportError(err: unknown, ctx?: Record<string, unknown>): void;

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
interface TelemetryEvent {
    level: 'info' | 'warn' | 'error';
    phase: string;
    event: string;
    fields: LogFields;
    ctx: LogContext;
    /** ISO-8601 timestamp, same value written to the JSON log line. */
    ts: string;
}
/** Sink an external package provides to receive bridge telemetry. */
interface TelemetryAdapter {
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
interface AdapterMeta {
    version: string;
    appId?: string;
    tenant?: string;
    /** Host machine identifier (e.g. `os.hostname()`). Useful as a stable
     *  `deviceId` for the telemetry sink — survives process restarts. */
    hostname?: string;
}
/** The shape an external module must default-export (or expose as `createAdapter`). */
type AdapterFactory = (meta: AdapterMeta) => TelemetryAdapter;

export { type AdapterFactory, type AdapterMeta, type Block, type FooterStatus, type RunState, type TelemetryAdapter, type TelemetryEvent, type Terminal, type ToolEntry, type ToolStatus, finalizeIfRunning, initialState, markInterrupted, reduce, renderCard, renderText, reportError, reportMetric };
