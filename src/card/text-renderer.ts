import type { PresentationMode } from '../config/schema';
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
export interface TextRenderOptions {
  presentationMode?: PresentationMode;
}

export function renderText(state: RunState, options: TextRenderOptions = {}): string {
  const presentationMode = options.presentationMode ?? 'debug';
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block, presentationMode);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer, presentationMode));
  }

  return parts.join('\n\n');
}

function renderBlock(block: Block, presentationMode: PresentationMode): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  if (presentationMode !== 'debug') return '';
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

function footerLine(
  status: 'thinking' | 'tool_running' | 'streaming',
  presentationMode: PresentationMode,
): string {
  if (presentationMode === 'clean') return '_处理中…_';
  if (presentationMode === 'progress') {
    if (status === 'thinking') return '_处理中：规划中…_';
    if (status === 'tool_running') return '_处理中：执行内部步骤…_';
    return '_处理中：整理回复…_';
  }
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
