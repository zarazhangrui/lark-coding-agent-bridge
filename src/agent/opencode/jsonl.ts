import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type OpencodeFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates opencode `run --format json` NDJSON events into AgentEvent[].
 *
 * In --format json mode the opencode CLI emits one JSON object per line via
 * its emit() function. There is NO standalone "done" event — the CLI breaks
 * its subscribe loop on `session.status idle` then exits. So termination is
 * stdout EOF (the adapter calls finish()/fail() at that point).
 *
 * Buffering mirrors CodexJsonlTranslator: opencode delivers text as complete
 * `text` events (with part.time.end), so we buffer the latest and emit prior
 * buffered text as a `text` delta when a newer text/tool event arrives; the
 * final buffered text becomes `final_text` on finish().
 *
 * The `system` event (carrying sessionId) is emitted exactly once: on the first
 * `text` event that arrives with a sessionId, where the text is newly buffered
 * (handleText returns [] because there is no prior pending message).  If the
 * first event is not text (reasoning / tool_use / unknown), the sessionId is
 * captured silently for the `done` event but no system event is injected in
 * front of real content.
 */
export class OpencodeJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private pendingAgentMessage: string | undefined;
  private systemEmitted = false;
  private drift: ProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    // Capture sessionId silently on first sight (any event type).
    const sid = stringValue(raw.sessionID ?? raw.sessionId);
    if (sid && !this.sessionId) {
      this.sessionId = sid;
    }

    let events: AgentEvent[];
    switch (raw.type) {
      case 'text':
        events = this.handleText(raw);
        break;
      case 'reasoning':
        events = this.handleReasoning(raw);
        break;
      case 'tool_use':
        events = this.handleToolUse(raw);
        break;
      case 'step_start':
      case 'step_finish':
        events = [];
        break;
      case 'error':
        events = this.handleError(raw);
        break;
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        events = [];
        break;
    }

    // Emit system event exactly once: only when this is a text event whose
    // content was fully buffered (events is empty from queueAgentMessage),
    // we have a sessionId, and we haven't emitted system yet.
    if (!this.systemEmitted && this.sessionId && raw.type === 'text' && events.length === 0) {
      this.systemEmitted = true;
      return [{ type: 'system', sessionId: this.sessionId }];
    }

    return events;
  }

  /**
   * Signal stream termination. Callers MUST pass an explicit reason:
   * `'normal'` for clean exit (exit code 0), otherwise the abnormal reason.
   * The default `'failed'` is a safety net for unexpected EOF but callers
   * should never rely on it for clean exits — that would produce an error event.
   */
  finish(reason: OpencodeFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events: AgentEvent[] = [];
    if (this.pendingAgentMessage) {
      events.push({ type: 'final_text', content: this.pendingAgentMessage });
      this.pendingAgentMessage = undefined;
    }
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      events.push({
        type: 'error',
        message: truncate(`opencode stream ended before a terminal event${detail}`, 4096),
        terminationReason: 'failed',
      });
    } else {
      events.push({ type: 'done', sessionId: this.sessionId, terminationReason: reason });
    }
    return events;
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.prependPendingText([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private handleText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) return [];
    return this.queueAgentMessage(text);
  }

  private handleReasoning(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) return [];
    return this.prependPendingText([{ type: 'thinking', delta: text }]);
  }

  private handleToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const id = stringValue(part?.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const name = stringValue(part?.tool) ?? 'tool';
    const state = recordValue(part?.state);
    const status = stringValue(state?.status);
    const isError = status === 'error';
    const errorText = stringValue(state?.error);
    const output = stringValue(part?.output) ?? stringValue(part?.text) ?? errorText ?? '';
    const events: AgentEvent[] = [
      { type: 'tool_use', id, name, input: { output } },
      { type: 'tool_result', id, output, isError },
    ];
    return this.prependPendingText(events);
  }

  private handleError(raw: Record<string, unknown>): AgentEvent[] {
    const message = errorMessage(raw, 'opencode error');
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    const events = this.pendingAgentMessage
      ? [{ type: 'text' as const, delta: this.pendingAgentMessage }]
      : [];
    this.pendingAgentMessage = message;
    return events;
  }

  private prependPendingText(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAgentMessage) return events;
    const pending = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return [{ type: 'text', delta: pending }, ...events];
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

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return (
    stringValue(nested?.message) ??
    stringValue(nested?.name) ??
    stringValue(raw.message) ??
    stringValue(raw.error) ??
    fallback
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
