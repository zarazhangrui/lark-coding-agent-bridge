import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

const BOUNDED_REPLY_MAX = 12000;
const TEXT_TRUNCATED_NOTICE =
  '\n\n_（回复过长，中间内容已截断；请继续追问以获取完整内容。）_\n\n';

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

/**
 * Bound only degraded fallback replies. Normal markdown/text delivery is left
 * intact because the channel SDK already rolls over or chunks long content.
 */
export function renderBoundedText(state: RunState, max = BOUNDED_REPLY_MAX): string {
  return truncateReply(renderText(state), max);
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

function truncateReply(content: string, max: number): string {
  if (content.length <= max) return content;
  const keep = Math.max(0, max - TEXT_TRUNCATED_NOTICE.length);
  const head = Math.floor(keep / 3);
  const tail = keep - head;
  return `${safeHead(content, head)}${TEXT_TRUNCATED_NOTICE}${safeTail(content, tail)}`;
}

function safeHead(content: string, length: number): string {
  let end = Math.min(length, content.length);
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return content.slice(0, end);
}

function safeTail(content: string, length: number): string {
  let start = Math.max(0, content.length - length);
  const first = content.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return content.slice(start);
}
