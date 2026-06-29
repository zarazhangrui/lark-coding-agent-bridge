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
  /** Set by `windowState` when any text was dropped, so the caller can resend
   * the full text as a standalone message (C2 fallback). */
  truncated?: boolean;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
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

export interface WindowOptions {
  maxTools: number;
  maxTextChars: number;
}

/**
 * Bound a RunState's blocks for card rendering: collapse old tool calls into a
 * single summary block and trim accumulated text to the most recent window.
 * Sets `truncated` when any text was dropped so the caller can resend the full
 * text as a standalone message (C2 fallback). Pure function; input untouched.
 */
export function windowState(state: RunState, opts: WindowOptions): RunState {
  const { maxTools, maxTextChars } = opts;
  const blocks = state.blocks;

  // Step 1: collapse old tool blocks into one summary when over maxTools.
  let blocksAfterTools: Block[] = blocks;
  if (maxTools >= 0) {
    const toolIndices: number[] = [];
    blocks.forEach((b, i) => {
      if (b.kind === 'tool') toolIndices.push(i);
    });
    if (toolIndices.length > maxTools) {
      const collapseCount = toolIndices.length - maxTools;
      const collapseSet = new Set(toolIndices.slice(0, collapseCount));
      const collapsedTools = toolIndices
        .slice(0, collapseCount)
        .map((i) => (blocks[i] as { kind: 'tool'; tool: ToolEntry }).tool);
      const headerList = collapsedTools.map((t) => `- ${t.name}`).join('\n');
      const summaryBlock: Block = {
        kind: 'text',
        content: `☕ ${collapseCount} earlier tool calls\n${headerList}`,
        streaming: false,
      };
      const rebuilt: Block[] = [];
      let inserted = false;
      blocks.forEach((b, i) => {
        if (collapseSet.has(i)) {
          if (!inserted) {
            rebuilt.push(summaryBlock);
            inserted = true;
          }
          return;
        }
        rebuilt.push(b);
      });
      blocksAfterTools = rebuilt;
    }
  }

  // Step 2: trim text from the front (keep the latest) when over maxTextChars.
  let totalText = 0;
  for (const b of blocksAfterTools) {
    if (b.kind === 'text') totalText += b.content.length;
  }
  let finalBlocks = blocksAfterTools;
  let textTruncated = false;
  if (totalText > maxTextChars) {
    textTruncated = true;
    let remaining = maxTextChars;
    const reversedOut: Block[] = [];
    for (let i = blocksAfterTools.length - 1; i >= 0; i--) {
      const b = blocksAfterTools[i]!;
      if (b.kind !== 'text') {
        reversedOut.push(b);
        continue;
      }
      const len = b.content.length;
      if (remaining >= len) {
        reversedOut.push(b);
        remaining -= len;
      } else if (remaining > 0) {
        const keep = b.content.slice(len - remaining);
        const omitted = len - remaining;
        reversedOut.push({
          kind: 'text',
          content: `…(omitted ${omitted} chars)\n${keep}`,
          streaming: false,
        });
        remaining = 0;
      } else {
        reversedOut.push({
          kind: 'text',
          content: `…(omitted ${len} chars)`,
          streaming: false,
        });
      }
    }
    finalBlocks = reversedOut.reverse();
  }

  return {
    ...state,
    blocks: finalBlocks,
    truncated: textTruncated,
  };
}

/**
 * Extract the agent's final reply from a run state: the text blocks after the
 * last tool call (or all text blocks when there were no tools). Text reply
 * mode posts this as the single standalone answer — the narration between tool
 * calls is dropped because the card/markdown stream already showed it and
 * `/last` recalls the full transcript.
 *
 * Pure function; the input state is not modified. When the joined reply
 * exceeds `maxTextChars` (default 4000, matching `windowState`), the head is
 * kept and a `/last` hint is appended so the user knows to recall the rest.
 */
export function finalReplyText(
  state: RunState,
  opts?: { maxTextChars?: number },
): string | undefined {
  const maxTextChars = opts?.maxTextChars ?? 4000;
  const blocks = state.blocks;
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === 'tool') {
      lastToolIdx = i;
      break;
    }
  }
  const texts: string[] = [];
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === 'text') texts.push(block.content);
  }
  if (texts.length === 0) return undefined;
  const joined = texts.join('\n');
  if (joined.length <= maxTextChars) return joined;
  return `${joined.slice(0, maxTextChars)}（/last 查看完整）`;
}

/**
 * Build the standalone completion notice posted when a run reaches a terminal
 * state. When `truncated` is set (the run's text exceeded the card window),
 * the notice points the user at `/last` to recall the full transcript instead
 * of the bridge re-dumping it into the chat.
 */
export function buildCompletionNotice(opts: {
  mins: number;
  toolCount: number;
  truncated: boolean;
}): string {
  const truncPart = opts.truncated ? ' · 输出较长，回复 /last 查看完整' : '';
  return `✅ 完成 · 耗时 ${opts.mins}m · ${opts.toolCount} 工具${truncPart} · /doctor 查详情`;
}
