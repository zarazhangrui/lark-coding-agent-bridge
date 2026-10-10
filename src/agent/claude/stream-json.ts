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
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string; text?: string; thinking?: string };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export interface ClaudeEventTranslator {
  translate(raw: unknown): AgentEvent[];
  /**
   * Flush any buffered text as ordinary progress (`text`). Used when the
   * process ends without a `result` (non-zero exit, kill): the last words the
   * agent produced are commentary, not a conclusion, and should still reach
   * the user. A normal run ends with `result`, which flushes as `final_text`.
   */
  flushAsText(): AgentEvent[];
}

/**
 * Stateful translator for claude's `stream-json` output.
 *
 * With `--include-partial-messages`, claude emits real-time token deltas as
 * `stream_event`/`content_block_delta` (`text_delta`/`thinking_delta`) before
 * the full `assistant` message. We forward those deltas as streaming `text` /
 * `thinking` events so the reply types out live in Feishu, and buffer the
 * final `assistant` text block as `final_text` (result) for the standalone
 * conclusion reply — mirroring codex/mimo.
 *
 * Without partial messages (older CLI), assistant text blocks arrive whole;
 * the first one streams as progress text, the last (before `result`) becomes
 * `final_text`. A single assistant message may carry several text blocks; we
 * join them so none is dropped.
 */
export function createTranslateEvent(): ClaudeEventTranslator {
  let pendingText: string | undefined;
  let streamingText = false;
  /** Final-answer candidate captured from an assistant block whose content was
   * already streamed via deltas. Emitted as final_text on result; never flushed
   * as progress text. */
  let finalCandidate: string | undefined;

  const flushPending = (events: AgentEvent[], asFinal: boolean): void => {
    if (pendingText === undefined) return;
    events.push(
      asFinal
        ? { type: 'final_text', content: pendingText }
        : { type: 'text', delta: pendingText },
    );
    pendingText = undefined;
  };

  return {
    translate(raw: unknown): AgentEvent[] {
      if (!raw || typeof raw !== 'object') return [];
      const evt = raw as ClaudeRawEvent;
      const events: AgentEvent[] = [];

      if (evt.type === 'system' && evt.subtype === 'init') {
        events.push({
          type: 'system',
          sessionId: evt.session_id,
          cwd: evt.cwd,
          model: evt.model,
        });
        return events;
      }

      // Token-level streaming deltas from --include-partial-messages.
      if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
        const delta = evt.event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          streamingText = true;
          events.push({ type: 'text', delta: delta.text });
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          events.push({ type: 'thinking', delta: delta.thinking });
        }
        return events;
      }

      if (evt.type === 'assistant' && evt.message?.content) {
        let sawToolUse = false;
        for (const block of evt.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            if (streamingText) {
              // This block's content was already emitted as stream deltas.
              // Keep it only as the final-answer candidate (result → final_text);
              // never re-emit or flush it as progress text.
              finalCandidate = block.text;
              
              continue;
            }
            // A text block that follows a tool_use in the same message is a new
            // turn's commentary; flush any buffered text as progress first.
            if (sawToolUse && pendingText !== undefined) {
              flushPending(events, false);
            }
            // Join consecutive text blocks instead of overwriting, so a single
            // assistant message with several text blocks loses nothing.
            pendingText = pendingText === undefined ? block.text : `${pendingText}${block.text}`;
          } else if (
            block.type === 'thinking' &&
            typeof block.thinking === 'string' &&
            block.thinking
          ) {
            events.push({ type: 'thinking', delta: block.thinking });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            sawToolUse = true;
            // A tool call ends the commentary turn. If the preceding text was
            // already streamed via deltas, it is held in finalCandidate (not
            // to be re-emitted); otherwise flush any buffered text as progress.
            if (!streamingText && pendingText !== undefined) {
              flushPending(events, false);
            }
            streamingText = false;
            // A new turn starts after a tool call: any prior final-answer
            // candidate is stale (a later block may carry the real conclusion).
            finalCandidate = undefined;
            events.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return events;
      }

      if (evt.type === 'user' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const output =
              typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            events.push({
              type: 'tool_result',
              id: block.tool_use_id,
              output,
              isError: block.is_error === true,
            });
          }
        }
        return events;
      }

      if (evt.type === 'result') {
        // Streaming mode: the answer was already shown via deltas; emit its
        // final candidate. Non-streaming mode: whatever text is still buffered
        // is the final answer.
        if (finalCandidate !== undefined) {
          events.push({ type: 'final_text', content: finalCandidate });
          finalCandidate = undefined;
        } else {
          flushPending(events, true);
        }
        if (evt.usage) {
          events.push({
            type: 'usage',
            inputTokens: evt.usage.input_tokens,
            outputTokens: evt.usage.output_tokens,
            cachedInputTokens: evt.usage.cache_read_input_tokens,
            costUsd: evt.total_cost_usd,
          });
        }
        events.push({ type: 'done', sessionId: evt.session_id, terminationReason: 'normal' });
      }
      return events;
    },

    flushAsText(): AgentEvent[] {
      const events: AgentEvent[] = [];
      flushPending(events, false);
      return events;
    },
  };
}

/** Backwards-compatible stateless wrapper for single-line callers/tests. */
export function translateEvent(raw: unknown): Generator<AgentEvent> {
  const translator = createTranslateEvent();
  return (function* () {
    for (const event of translator.translate(raw)) yield event;
  })();
}
