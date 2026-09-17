import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type KimiFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates kimi's `--output-format stream-json` JSONL into AgentEvents.
 *
 * Observed line shapes (kimi 0.36.x):
 *   {"role":"meta","type":"system.version","version":"..."}
 *   {"role":"meta","type":"turn.step.retrying","error_name":"...","error_message":"...",...}
 *   {"role":"assistant","content":"...","tool_calls":[{"type":"function","id":"..","function":{"name":"..","arguments":"{...}"}}]}
 *   {"role":"tool","tool_call_id":"..","content":".."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...","command":"kimi -r ...",...}
 *
 * The stream has no terminal event: the session id arrives late (in the
 * trailing `session.resume_hint` meta) and a successful run is signalled by
 * EOF plus exit code 0. The owning adapter calls finish()/fail() once the
 * process state is known.
 */
export class KimiStreamTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private pendingAssistantText: string | undefined;
  private readonly seenToolCalls = new Set<string>();
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.role !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.role) {
      case 'meta':
        return this.translateMeta(raw);
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool':
        return this.translateTool(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('kimi-stream', 'unknown_event', { role: raw.role });
        return [];
    }
  }

  /**
   * End-of-stream handling, driven by the adapter once it knows the process
   * exit state. 'normal' promotes the last assistant message to final_text;
   * anything else ends in done (interrupted/timeout) or error (failed).
   */
  finish(reason: KimiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'normal') {
      const events: AgentEvent[] = [];
      if (this.pendingAssistantText) {
        events.push({ type: 'final_text', content: this.pendingAssistantText });
        this.pendingAssistantText = undefined;
      }
      events.push({ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' });
      return events;
    }
    if (reason === 'interrupted' || reason === 'timeout') {
      return this.prependPendingText([
        { type: 'done', sessionId: this.sessionId, terminationReason: reason },
      ]);
    }
    const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
    return this.prependPendingText([
      {
        type: 'error',
        message: truncate(`kimi stream ended without completing the turn${detail}`, 4096),
        terminationReason: 'failed',
      },
    ]);
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

  private translateMeta(raw: Record<string, unknown>): AgentEvent[] {
    const metaType = stringValue(raw.type);
    if (metaType === 'session.resume_hint') {
      const sessionId = stringValue(raw.session_id ?? raw.sessionId);
      if (!sessionId) {
        this.drift.anomalies++;
        return [];
      }
      if (sessionId === this.sessionId) return [];
      this.sessionId = sessionId;
      return [{ type: 'system', sessionId }];
    }
    if (metaType === 'system.version') {
      return [];
    }
    // Other meta events (e.g. turn.step.retrying) report recoverable trouble.
    const message = stringValue(raw.error_message ?? raw.errorMessage ?? raw.message);
    if (message) {
      this.lastNonTerminalError = message;
      log.warn('kimi-stream', 'meta_event', { metaType, message: truncate(message, 500) });
    }
    return [];
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const content = stringValue(raw.content);
    if (content) {
      events.push(...this.queueAssistantText(content));
    }
    const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    const toolEvents: AgentEvent[] = [];
    for (const call of toolCalls) {
      const record = recordValue(call);
      if (!record) {
        this.drift.anomalies++;
        continue;
      }
      const id = stringValue(record.id);
      const fn = recordValue(record.function);
      const name = stringValue(fn?.name ?? record.name);
      if (!id || !name) {
        this.drift.anomalies++;
        continue;
      }
      if (this.seenToolCalls.has(id)) continue;
      this.seenToolCalls.add(id);
      toolEvents.push({
        type: 'tool_use',
        id,
        name,
        input: parseToolArguments(fn?.arguments ?? record.arguments),
      });
    }
    if (toolEvents.length > 0) {
      // Progress commentary precedes the tool calls it announces.
      events.push(...this.prependPendingText(toolEvents));
    }
    return events;
  }

  private translateTool(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.tool_call_id ?? raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.seenToolCalls.has(id)) {
      this.drift.anomalies++;
    }
    return this.prependPendingText([
      {
        type: 'tool_result',
        id,
        output: stringValue(raw.content) ?? '',
        isError: raw.is_error === true,
      },
    ]);
  }

  /**
   * kimi emits one complete assistant message per step; the message before a
   * tool call is progress commentary and the last one is the final answer.
   * Hold the most recent text back as pending: a following assistant message
   * demotes the previous one to streamed text, and finish('normal') promotes
   * the survivor to final_text. Identical repeats are the same message
   * re-announced, not new text.
   */
  private queueAssistantText(content: string): AgentEvent[] {
    if (content === this.pendingAssistantText) return [];
    const events = this.pendingAssistantText
      ? [{ type: 'text' as const, delta: this.pendingAssistantText }]
      : [];
    this.pendingAssistantText = content;
    return events;
  }

  private prependPendingText(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAssistantText) return events;
    const pending = this.pendingAssistantText;
    this.pendingAssistantText = undefined;
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

/** tool_calls[].function.arguments is a JSON-encoded string; decode it, keep the raw string on failure. */
function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
