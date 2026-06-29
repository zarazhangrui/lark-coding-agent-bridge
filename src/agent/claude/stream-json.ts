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

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[]; model?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  // `result` events carry the run outcome. On an API/auth failure the CLI
  // still exits via a result line with is_error set (subtype stays "success"),
  // the failing HTTP status in api_error_status, and the message in `result`.
  is_error?: boolean;
  api_error_status?: number;
  result?: string;
  // Top-level marker on a synthetic assistant turn that wraps an API error
  // (e.g. "authentication_failed"). Its message.model is "<synthetic>".
  error?: string;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    // A synthetic assistant turn carrying an API error (e.g. 403 auth) arrives
    // with a top-level `error` ("authentication_failed") and model
    // "<synthetic>". Its only "content" is the error string — don't stream it
    // as a normal reply. The trailing `result` event (is_error) carries the
    // failure to the bridge instead, so it surfaces exactly once.
    if (evt.error) return;
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    // is_error means the run failed (API/auth error, exceeded turns, etc.).
    // subtype is unreliable here — a 403 still reports subtype "success" — so
    // key off is_error and surface a real error event instead of a clean done.
    if (evt.is_error) {
      yield { type: 'error', message: resultErrorMessage(evt), terminationReason: 'failed' };
      return;
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

function resultErrorMessage(evt: ClaudeRawEvent): string {
  if (typeof evt.result === 'string' && evt.result.trim()) return evt.result.trim();
  if (typeof evt.api_error_status === 'number') return `claude API error ${evt.api_error_status}`;
  return 'claude reported an error';
}
