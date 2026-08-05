import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type KimiFinishReason = 'failed' | 'normal' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates `kimi --output-format stream-json` lines (one JSON object per
 * line) into bridge AgentEvents.
 *
 * Kimi's schema differs from claude/codex: the top-level discriminator is
 * `role`, with the concrete variant in `type`:
 *
 *   {"role":"meta","type":"system.version","version":"0.33.0"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r ..."}
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"tool_xxx","function":{"name":"Read","arguments":"{\"path\":\"probe.txt\"}"}}]}
 *   {"role":"assistant","content":"回复文本"}
 *   {"role":"tool","tool_call_id":"tool_xxx","content":"..."}
 *
 * There is no terminal event in the stream: a run just ends. The adapter calls
 * finish() with the actual outcome once the child exits, so the translator
 * never emits done/error from inside translate() except via fail().
 */
export class KimiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private pendingAgentMessage: string | undefined;
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
        log.warn('jsonl', 'unknown_event', { role: raw.role });
        return [];
    }
  }

  finish(reason: KimiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return this.prependPendingText([
        {
          type: 'error',
          message: truncate(`kimi stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ]);
    }
    // Interrupted/timeout still flush the partial answer as final_text — a
    // half-finished reply is more useful to the user than losing it entirely
    // (deviation from the plan, which only flushed final_text on the normal
    // path; all non-failed outcomes flush it).
    return this.prependPendingText([
      { type: 'done', sessionId: this.sessionId, terminationReason: reason },
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
    const type = stringValue(raw.type);
    if (type === 'session.resume_hint') {
      const sessionId = stringValue(raw.session_id ?? raw.sessionId);
      if (!sessionId) {
        this.drift.anomalies++;
        return [];
      }
      this.sessionId = sessionId;
      return [{ type: 'system', sessionId }];
    }
    if (type === 'system.version') {
      // version banner; not actionable by the bridge
      return [];
    }
    this.drift.unknownEvents++;
    log.warn('jsonl', 'unknown_event', { role: 'meta', type });
    return [];
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const call of toolCalls) {
      const record = recordValue(call);
      const id = stringValue(record?.id);
      if (!record || !id) {
        this.drift.anomalies++;
        continue;
      }
      const fn = recordValue(record.function);
      events.push({
        type: 'tool_use',
        id,
        name: stringValue(fn?.name) ?? 'unknown',
        input: parseFunctionArguments(stringValue(fn?.arguments)),
      });
    }
    const content = stringValue(raw.content);
    if (content) {
      events.push(...this.queueAgentMessage(content));
    }
    return events;
  }

  private translateTool(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.tool_call_id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    return this.prependPendingText([
      {
        type: 'tool_result',
        id,
        output: stringValue(raw.content) ?? '',
        isError: false,
      },
    ]);
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    // kimi can announce the same text more than once (e.g. a streaming
    // assistant event and the final snapshot). An identical repeat is the
    // same message, not a new one — otherwise it would stream as progress
    // commentary and then again as the final answer.
    if (message === this.pendingAgentMessage) return [];
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

function parseFunctionArguments(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // arguments not serializable as JSON — pass through verbatim
    return raw;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
