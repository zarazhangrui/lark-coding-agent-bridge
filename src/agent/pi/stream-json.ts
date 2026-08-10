import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type PiFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates pi's `--mode json` NDJSON stream into bridge AgentEvents.
 *
 * pi emits one AgentEvent per line (packages/agent/src/types.ts:413), preceded
 * by a `session` header line (print-mode.ts) that is NOT part of the AgentEvent
 * union. Mapping policy (fixes report sec 1.2 "5 of 10 silently dropped"):
 * - `session` header            -> system (sessionId, cwd)
 * - message_update text_delta   -> text
 * - message_update thinking_delta -> thinking
 * - message_end                 -> usage (synthesized from message.usage; decision C)
 * - tool_execution_start        -> tool_use  (authoritative; toolcall_end is dropped
 *                                   to avoid duplicate ids — execution boundary wins)
 * - tool_execution_update       -> tool_progress (live output tail routed into the
 *                                   running tool's output field, rendered inside its
 *                                   panel — not as standalone text)
 * - tool_execution_end          -> tool_result
 * - agent_end                   -> done
 * - agent_start, turn_*, message_start -> dropped (lifecycle markers)
 * - unknown                     -> drift counter + warn (never silent)
 *
 * Modeled on CodexJsonlTranslator (stateful class carrying sessionId so `done`
 * events can reference it), NOT claude's stateless generator.
 */
export class PiJsonTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
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
      case 'session':
        return this.translateSessionHeader(raw);
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'tool_execution_start':
        return this.translateToolExecutionStart(raw);
      case 'tool_execution_update':
        return this.translateToolExecutionUpdate(raw);
      case 'tool_execution_end':
        return this.translateToolExecutionEnd(raw);
      case 'agent_end':
        return this.translateAgentEnd();
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
        // RPC-only: internal queue state change (e.g. steer enqueued).
        return [];
      case 'response':
        // RPC ack for a command we sent — consumed by RpcConnection, not
        // an AgentSessionEvent. Silently drop in the translator so the
        // shared event-processing path works for both spawn and RPC modes.
        return [];
      case 'extension_ui_request':
        // RPC-only: extension UI dialog (auto-responded by RpcConnection).
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('pi-json', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: PiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return [
        {
          type: 'error',
          message: truncate(`pi stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateSessionHeader(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.id ?? raw.sessionId);
    if (id) this.sessionId = id;
    const cwd = stringValue(raw.cwd);
    return [{ type: 'system', sessionId: id, cwd }];
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const ev = recordValue(raw.assistantMessageEvent);
    if (!ev || typeof ev.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }
    switch (ev.type) {
      case 'text_delta': {
        const delta = stringValue(ev.delta);
        return delta ? [{ type: 'text', delta }] : [];
      }
      case 'thinking_delta': {
        const delta = stringValue(ev.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'error':
        return this.translateAssistantError(ev);
      default:
        // text_start/text_end/thinking_start/thinking_end/toolcall_*/start/done:
        // boundary markers — the delta members already carry streaming content.
        return [];
    }
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    // Decision C: synthesize a usage event from the assistant message usage,
    // symmetric with claude/codex. pi has no dedicated usage AgentEvent.
    const message = recordValue(raw.message);
    const usage = recordValue(message?.usage);
    if (!usage) return [];
    const event: AgentEvent = {
      type: 'usage',
      inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
      outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
      cachedInputTokens: numberValue(
        usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? usage.cacheReadInputTokens,
      ),
      reasoningOutputTokens: numberValue(
        usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
      ),
    };
    return [event];
  }

  private translateToolExecutionStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    return [
      {
        type: 'tool_use',
        id,
        name: stringValue(raw.toolName) ?? 'tool',
        input: raw.args ?? {},
      },
    ];
  }

  private translateToolExecutionUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const text = coerceAnyOutput(raw.partialResult);
    if (!text) return [];
    const id = stringValue(raw.toolCallId);
    if (!id) return [];
    return [{ type: 'tool_progress', id, delta: text }];
  }

  private translateToolExecutionEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    return [
      {
        type: 'tool_result',
        id,
        output: coerceAnyOutput(raw.result),
        isError: raw.isError === true,
      },
    ];
  }

  private translateAgentEnd(): AgentEvent[] {
    this.terminal = true;
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' }];
  }

  private translateAssistantError(ev: Record<string, unknown>): AgentEvent[] {
    const err = recordValue(ev.error);
    const message =
      stringValue(ev.reason) ??
      stringValue(err?.errorMessage) ??
      stringValue(err?.stopReason) ??
      'pi assistant error';
    this.lastNonTerminalError = message;
    log.warn('pi-json', 'assistant_error', { message: truncate(message, 500) });
    return [];
  }
}

/** Extract a flat string from a tool result/partialResult payload of any shape. */
function coerceAnyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = recordValue(value);
  if (!record) return '';
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const p = recordValue(part);
        return p && typeof p.text === 'string' ? p.text : '';
      })
      .join('');
    if (text) return text;
  }
  if (typeof record.text === 'string') return record.text;
  if (typeof record.output === 'string') return record.output;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
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

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
