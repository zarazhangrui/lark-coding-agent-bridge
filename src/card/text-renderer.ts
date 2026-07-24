import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

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
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }
  if (state.finalText?.trim()) {
    parts.push(state.finalText.trim());
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return parts.join('\n\n');
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
