import type { AgentEvent } from '../types';
import { translateEvent } from '../claude/stream-json';

/**
 * Grok `--output-format streaming-messages-json` follows the Anthropic
 * Messages stream-json shape that {@link translateEvent} already understands.
 * Error `result` subtypes are mapped to a terminal `error` event instead of
 * a successful `done`.
 */
export function* translateGrokEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: unknown;
    errors?: unknown;
  };
  if (evt.type === 'result' && isGrokErrorResult(evt)) {
    yield {
      type: 'error',
      message: grokErrorMessage(evt),
      terminationReason: 'failed',
    };
    return;
  }
  yield* translateEvent(raw);
}

function isGrokErrorResult(evt: { subtype?: string; is_error?: boolean }): boolean {
  if (evt.is_error === true) return true;
  return typeof evt.subtype === 'string' && evt.subtype.startsWith('error');
}

function grokErrorMessage(evt: { subtype?: string; result?: unknown; errors?: unknown }): string {
  if (typeof evt.result === 'string' && evt.result.trim()) return evt.result.trim();
  if (Array.isArray(evt.errors) && evt.errors.length > 0) {
    const first = evt.errors[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object' && typeof (first as { message?: unknown }).message === 'string') {
      return (first as { message: string }).message;
    }
  }
  return `grok run failed (${evt.subtype ?? 'error'})`;
}
