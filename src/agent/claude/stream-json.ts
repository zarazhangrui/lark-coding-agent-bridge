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
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /**
     * Per-attempt usage for a single assistant message — measured to be the
     * run's last one (see `contextFromIterations`). The sibling totals are
     * cumulative over every request the agentic loop made, so this is the only
     * usable source for context size.
     */
    iterations?: Array<{
      /** `message`, or `fallback_message` when an attempt was re-served. */
      type?: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }>;
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
  total_cost_usd?: number;
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
        contextTokens: contextFromIterations(evt.usage.iterations),
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        cacheCreationInputTokens: evt.usage.cache_creation_input_tokens,
        contextWindow: soleContextWindow(evt.modelUsage),
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

/**
 * The model's context window, but only when it can be attributed unambiguously.
 *
 * `modelUsage` is keyed by model id and says nothing about which model produced
 * the final message, so a turn that touched more than one — a fallback, say —
 * gives no way to pick the right denominator. Guessing the largest would size
 * the percentage against a window the answer may never have run in and quietly
 * under-report it. One entry is unambiguous; anything else drops the
 * percentage and leaves the token count standing on its own.
 */
function soleContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length !== 1) return undefined;
  const w = entries[0]?.contextWindow;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : undefined;
}

/**
 * Context size going into the next turn, from the run's final request.
 *
 * The top-level `usage` totals cannot be used for this: one `claude -p` run
 * drives a whole agentic loop, and those fields sum **every** request it made.
 * A four-tool-call run measured 160,500 there against a real context of 40,194
 * — four times over, and past the 1M window within a normal session.
 *
 * `usage.iterations` carries one assistant message's own usage, and measurement
 * puts it at the run's last: with a long closing answer its `output_tokens` was
 * that message's alone, not the run's, and a run that read two files reported
 * the post-read prompt rather than the pre-read one. Cross-checked against the
 * transcript Claude Code writes, whose final assistant message reports the same
 * figure to the token. Its three prompt buckets are disjoint, so they add up to
 * that request's whole prompt; plus its output, that is what the next turn
 * starts from.
 *
 * Not proven for fallback, refusal-retry, or compaction turns — none has been
 * observed carrying more than one iteration. Taking the last entry is right if
 * they stay in request order (the served attempt is documented to come last),
 * but that ordering is assumed, not measured.
 *
 * Returns `undefined` when there are no iterations — the totals can't be
 * decomposed, and no footer beats a fourfold-wrong one.
 */
function contextFromIterations(
  iterations:
    | Array<{
        type?: string;
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }>
    | undefined,
): number | undefined {
  if (!Array.isArray(iterations) || iterations.length === 0) return undefined;
  const last = iterations[iterations.length - 1];
  if (!last || typeof last !== 'object') return undefined;
  const total =
    (last.input_tokens ?? 0) +
    (last.cache_read_input_tokens ?? 0) +
    (last.cache_creation_input_tokens ?? 0) +
    (last.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}
