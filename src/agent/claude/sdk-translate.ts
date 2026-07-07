import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SdkRawMessage {
  type?: string;
  subtype?: string;
  error?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  tool_name?: string;
  decision_reason?: string;
  message?: { content?: ContentBlock[] } | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Translate one SDKMessage into zero or more AgentEvents. Mirrors the field
 * access of the previous stream-json translator — SDK assistant/user messages
 * carry the same Anthropic content-block schema and usage token names.
 */
export function translateSdkMessage(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const msg = raw as SdkRawMessage;
  const out: AgentEvent[] = [];

  if (msg.type === 'system' && msg.subtype === 'init') {
    out.push({ type: 'system', sessionId: msg.session_id, cwd: msg.cwd, model: msg.model });
    return out;
  }

  if (msg.type === 'system' && msg.subtype === 'permission_denied') {
    const tool = msg.tool_name ?? 'unknown';
    const why =
      (typeof msg.decision_reason === 'string' && msg.decision_reason) ||
      (typeof msg.message === 'string' && msg.message) ||
      'permission denied';
    out.push({ type: 'notice', text: `工具 ${tool} 被自动拒绝：${why}` });
    return out;
  }

  if (msg.type === 'assistant') {
    // A refusal / auth / billing error surfaces on the assistant frame.
    if (typeof msg.error === 'string' && msg.error) {
      out.push({ type: 'error', message: `claude error: ${msg.error}`, terminationReason: 'failed' });
      return out;
    }
    const content = typeof msg.message === 'object' ? (msg.message?.content ?? []) : [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push({ type: 'text', delta: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        out.push({ type: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return out;
  }

  if (msg.type === 'user') {
    const content = typeof msg.message === 'object' ? (msg.message?.content ?? []) : [];
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : (JSON.stringify(block.content) ?? '');
        out.push({
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        });
      }
    }
    return out;
  }

  if (msg.type === 'result') {
    if (msg.subtype && msg.subtype !== 'success') {
      out.push({
        type: 'error',
        message: `claude run failed: ${msg.subtype}`,
        terminationReason: 'failed',
      });
      return out;
    }
    if (msg.usage) {
      out.push({
        type: 'usage',
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cachedInputTokens: msg.usage.cache_read_input_tokens,
        costUsd: msg.total_cost_usd,
      });
    }
    out.push({ type: 'done', sessionId: msg.session_id, terminationReason: 'normal' });
    return out;
  }

  return out;
}
