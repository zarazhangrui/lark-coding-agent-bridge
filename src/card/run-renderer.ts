import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;
const CARD_BODY_ELEMENT_MAX = 10;
const CARD_TOTAL_ELEMENT_MAX = 45;
const CARD_SERIALIZED_MAX_BYTES = 24_000;
const CARD_MARKDOWN_TABLE_MAX = 3;
const TEXT_BLOCK_MAX = 6000;
const TOOL_SUMMARY_MAX = 6000;
const TEXT_TRUNCATED_NOTICE =
  '\n\n_（回复过长，中间内容已截断以避免飞书卡片发送失败。）_\n\n';

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
}

export function getCardPayloadViolation(card: object): string | undefined {
  const serialized = JSON.stringify(card);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > CARD_SERIALIZED_MAX_BYTES) {
    return `serialized card is ${bytes} bytes (limit ${CARD_SERIALIZED_MAX_BYTES})`;
  }

  const stats = inspectCardPayload(card);
  if (stats.elements > CARD_TOTAL_ELEMENT_MAX) {
    return `card has ${stats.elements} elements (limit ${CARD_TOTAL_ELEMENT_MAX})`;
  }
  if (stats.tables > CARD_MARKDOWN_TABLE_MAX) {
    return `card has ${stats.tables} markdown tables (limit ${CARD_MARKDOWN_TABLE_MAX})`;
  }
  return undefined;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const contentElements: object[] = [];
  const trailingElements: object[] = [];

  if (state.reasoning.content) {
    contentElements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        contentElements.push(markdown(group.content));
      }
    } else {
      contentElements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    trailingElements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    trailingElements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    trailingElements.push(noteMd(`⚠️ agent 失败：${truncate(state.errorMsg, 2000)}`));
  } else if (state.terminal === 'done' && contentElements.length === 0) {
    contentElements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) trailingElements.push(footerStatus(state.footer));
    trailingElements.push(stopButton(options));
  }

  // Feishu counts nested card nodes toward its element limit. Keeping the
  // top-level body conservative leaves room for each collapsible panel's
  // child markdown element while preserving terminal controls and notices.
  const contentLimit = Math.max(0, CARD_BODY_ELEMENT_MAX - trailingElements.length);
  const elements = [
    ...limitBodyElements(contentElements, contentLimit),
    ...trailingElements,
  ];

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = limitToolSummary(
    tools.map((t) => `- ${toolHeaderText(t)}`),
    TOOL_SUMMARY_MAX,
  );
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content: truncateWithNotice(content, TEXT_BLOCK_MAX) };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${safeHead(s, max)}…` : s;
}

function truncateWithNotice(content: string, max: number): string {
  if (content.length <= max) return content;
  const keep = Math.max(0, max - TEXT_TRUNCATED_NOTICE.length);
  const head = Math.floor(keep / 3);
  const tail = keep - head;
  return `${safeHead(content, head)}${TEXT_TRUNCATED_NOTICE}${safeTail(content, tail)}`;
}

function limitBodyElements(elements: object[], max: number): object[] {
  if (elements.length <= max) return elements;
  if (max <= 0) return [];

  const keep = Math.max(0, max - 1);
  const omitted = elements.length - keep;
  return [
    noteMd(`_（较早的 ${omitted} 个过程块已折叠，以避免飞书卡片元素超限。）_`),
    ...elements.slice(-keep),
  ];
}

function limitToolSummary(lines: string[], max: number): string {
  const full = lines.join('\n');
  if (full.length <= max) return full;

  const kept: string[] = [];
  let used = 0;
  // Reserve enough room for the omission notice, including a large count.
  const budget = Math.max(0, max - 80);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const nextSize = line.length + (kept.length > 0 ? 1 : 0);
    if (used + nextSize > budget) break;
    kept.push(line);
    used += nextSize;
  }
  kept.reverse();
  const omitted = lines.length - kept.length;
  const notice = `_（较早的 ${omitted} 个工具调用已省略。）_`;
  return safeHead(`${notice}\n${kept.join('\n')}`, max);
}

function inspectCardPayload(value: unknown): { elements: number; tables: number } {
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const next = inspectCardPayload(item);
        return {
          elements: total.elements + next.elements,
          tables: total.tables + next.tables,
        };
      },
      { elements: 0, tables: 0 },
    );
  }
  if (!value || typeof value !== 'object') {
    return { elements: 0, tables: 0 };
  }

  const record = value as Record<string, unknown>;
  let elements = typeof record.tag === 'string' ? 1 : 0;
  let tables = typeof record.content === 'string' ? countMarkdownTables(record.content) : 0;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'content' || key === 'tag') continue;
    const next = inspectCardPayload(child);
    elements += next.elements;
    tables += next.tables;
  }
  return { elements, tables };
}

function countMarkdownTables(content: string): number {
  let tables = 0;
  let fence: '```' | '~~~' | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const marker = trimmed.startsWith('```') ? '```' : '~~~';
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (fence) continue;

    const row = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    const cells = row.split('|').map((cell) => cell.trim());
    if (cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      tables += 1;
    }
  }
  return tables;
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
