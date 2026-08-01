import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translate `mimo run --format json` JSONL events into bridge AgentEvents.
 *
 * mimo's headless protocol differs from claude/codex in one important way:
 * there is NO terminal stream event. Completion is signalled by the process
 * exiting (code 0). This translator streams text/tool events live, and the
 * adapter calls `finish()` / `fail()` once the child has exited to emit
 * `final_text` + `done` or `error`.
 *
 * Event mapping:
 *   step_start  -> system (captures sessionID for resume)
 *   text        -> text delta (accumulated for final_text)
 *   reasoning   -> thinking delta (only emitted when run with --thinking)
 *   tool_use    -> tool_use + tool_result (a single mimo event carries both
 *                  the call and its completed/error outcome)
 *   step_finish -> usage (tokens), no terminal semantics
 *   error       -> non-terminal error note, surfaced at process exit
 */
export class MimoJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private readonly textParts: string[] = [];
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'step_start':
        return this.translateStepStart(raw);
      case 'text':
        return this.translateText(raw);
      case 'reasoning':
        return this.translateReasoning(raw);
      case 'tool_use':
        return this.translateToolUse(raw);
      case 'step_finish':
        return this.translateStepFinish(raw);
      case 'error':
        return this.translateError(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('mimo-jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  /**
   * Process exited. `reason 'normal'` flushes accumulated text as final_text
   * and emits done; other reasons emit done with the given termination reason
   * (the caller is expected to have already streamed the failure detail, e.g.
   * via `fail`).
   */
  finish(reason: 'normal' | 'interrupted' | 'timeout'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events: AgentEvent[] = [];
    const content = this.textParts.join('');
    if (reason === 'normal' && content) {
      events.push({ type: 'final_text', content });
    }
    events.push({ type: 'done', sessionId: this.sessionId, terminationReason: reason });
    return events;
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
    return [
      {
        type: 'error',
        message: truncate(`${message}${detail}`, 4096),
        terminationReason: 'failed',
      },
    ];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateStepStart(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.sessionID ?? raw.sessionId) ?? stringValue(recordValue(raw.part)?.sessionID);
    if (!sessionId) {
      this.drift.anomalies++;
      return [];
    }
    const first = this.sessionId === undefined;
    this.sessionId = sessionId;
    return first ? [{ type: 'system', sessionId }] : [];
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) {
      this.drift.anomalies++;
      return [];
    }
    this.textParts.push(text);
    return [{ type: 'text', delta: text }];
  }

  private translateReasoning(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) {
      this.drift.anomalies++;
      return [];
    }
    return [{ type: 'thinking', delta: text }];
  }

  private translateToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part || part.type !== 'tool') {
      this.drift.anomalies++;
      return [];
    }
    const name = stringValue(part.tool);
    const state = recordValue(part.state);
    const id = stringValue(part.callID) ?? stringValue(part.id);
    if (!name || !id) {
      this.drift.anomalies++;
      return [];
    }
    const status = stringValue(state?.status);
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        id,
        name,
        input: state?.input ?? {},
      },
    ];
    // mimo emits a tool call exactly once, already completed or errored —
    // resolve it immediately so the card shows the outcome.
    events.push({
      type: 'tool_result',
      id,
      output: stringValue(state?.output) ?? '',
      isError: status === 'error',
    });
    return events;
  }

  private translateStepFinish(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const tokens = recordValue(part?.tokens);
    if (!tokens) return [];
    return [
      {
        type: 'usage',
        inputTokens: numberValue(tokens.input),
        outputTokens: numberValue(tokens.output),
        cachedInputTokens: numberValue(recordValue(tokens.cache)?.read),
        reasoningOutputTokens: numberValue(tokens.reasoning),
      },
    ];
  }

  private translateError(raw: Record<string, unknown>): AgentEvent[] {
    const message = errorMessage(raw, 'mimo error');
    this.lastNonTerminalError = message;
    log.warn('mimo-jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const error = recordValue(raw.error);
  const data = recordValue(error?.data);
  return (
    stringValue(data?.message) ??
    stringValue(error?.message) ??
    stringValue(raw.message) ??
    fallback
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
