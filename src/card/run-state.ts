import type { AgentEvent } from '../agent/types';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type EventLogEntry =
  | { type: 'text'; ts: number; preview: string }
  | { type: 'thinking'; ts: number; preview: string }
  | { type: 'tool_use'; ts: number; preview: string; detail: string }
  | { type: 'tool_result'; ts: number; preview: string; detail: string }
  | { type: 'system'; ts: number; preview: string; detail: string }
  | { type: 'usage'; ts: number; preview: string; detail: string }
  | { type: 'done'; ts: number; preview: string }
  | { type: 'error'; ts: number; preview: string };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;

export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /** Verbose event log — raw AgentEvent stream, capped at MAX_EVENT_LOG entries.
   *  Only populated when showEventLog is enabled. */
  eventLog: EventLogEntry[];
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
  eventLog: [],
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return {
        ...state,
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}

/** Maximum events kept in the verbose event log. Older entries are dropped. */
export const MAX_EVENT_LOG = 200;

/**
 * Capture an AgentEvent into a compact EventLogEntry.
 * Called for every event when verbose mode is on — before reduce().
 * Consecutive text/thinking deltas are coalesced into the last entry
 * to avoid flooding the log with per-token fragments.
 */
export function captureEvent(
  log: EventLogEntry[],
  evt: AgentEvent,
  now: number,
): EventLogEntry[] {
  const last = log[log.length - 1];

  // Coalesce consecutive text deltas.
  if (evt.type === 'text' && last?.type === 'text') {
    const merged = last.preview + evt.delta;
    return [...log.slice(0, -1), { type: 'text', ts: last.ts, preview: truncate(merged, 500) }];
  }
  // Coalesce consecutive thinking deltas.
  if (evt.type === 'thinking' && last?.type === 'thinking') {
    const merged = last.preview + evt.delta;
    return [...log.slice(0, -1), { type: 'thinking', ts: last.ts, preview: truncate(merged, 500) }];
  }

  const entry = toEntry(evt, now);
  const next = [...log, entry];
  return next.length > MAX_EVENT_LOG ? next.slice(-MAX_EVENT_LOG) : next;
}

function toEntry(evt: AgentEvent, now: number): EventLogEntry {
  switch (evt.type) {
    case 'text':
      return { type: 'text', ts: now, preview: truncate(evt.delta, 500) };
    case 'thinking':
      return { type: 'thinking', ts: now, preview: truncate(evt.delta, 500) };
    case 'tool_use':
      return {
        type: 'tool_use',
        ts: now,
        preview: `${evt.name}(${summarizeInput(evt.input)})`,
        detail: truncate(JSON.stringify(evt.input), 2000),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        ts: now,
        preview: truncate(evt.output, 100),
        detail: truncate(evt.output, 2000),
      };
    case 'system':
      return {
        type: 'system',
        ts: now,
        preview: `session=${truncate(evt.sessionId ?? '?', 20)}`,
        detail: truncate(JSON.stringify({ sessionId: evt.sessionId, model: evt.model, cwd: evt.cwd }), 2000),
      };
    case 'usage':
      return {
        type: 'usage',
        ts: now,
        preview: `in=${evt.inputTokens ?? '?'} out=${evt.outputTokens ?? '?'} cost=$${evt.costUsd ?? 0}`,
        detail: truncate(JSON.stringify(evt), 2000),
      };
    case 'done':
      return { type: 'done', ts: now, preview: evt.terminationReason };
    case 'error':
      return { type: 'error', ts: now, preview: truncate(evt.message, 200) };
  }
}

function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 80);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // Common tool inputs: command, path, pattern, prompt
    const cmd = obj.command ?? obj.path ?? obj.pattern ?? obj.prompt ?? obj.content;
    if (typeof cmd === 'string') return truncate(cmd, 80);
  }
  return truncate(JSON.stringify(input), 80);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
