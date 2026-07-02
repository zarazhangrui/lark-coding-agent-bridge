import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type PiFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

const IGNORED_EVENT_TYPES = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'message_start',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  // Real pi event types not emphasized by json.md's docs table but present in
  // pi's actual AgentSessionEvent/AgentEvent unions (packages/agent/src/types.ts):
  // tool_execution_update streams on every partial tool-output chunk (e.g. a
  // long-running bash command) and would otherwise spam unknown_event drift.
  'tool_execution_update',
  'session_info_changed',
  'thinking_level_changed',
]);

const IGNORED_ASSISTANT_MESSAGE_EVENT_TYPES = new Set([
  'start',
  'text_start',
  'text_end',
  'thinking_start',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  // Cannot actually occur inside message_update in pi's real event stream
  // (verified against pi-mono's agent-loop.ts); the terminal message_end's
  // stopReason/errorMessage is the only real error-detection path. Kept here
  // only so a doc-driven future event never silently counts as drift.
  'error',
]);

export class PiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
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
        return this.translateSession(raw);
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'tool_execution_start':
        return this.translateToolExecutionStart(raw);
      case 'tool_execution_end':
        return this.translateToolExecutionEnd(raw);
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'agent_end':
        return this.translateAgentEnd();
      case 'extension_error':
        log.warn('jsonl', 'extension_error', {
          extensionPath: stringValue(raw.extensionPath),
          message: truncate(stringValue(raw.error) ?? '', 500),
        });
        return [];
      default:
        if (IGNORED_EVENT_TYPES.has(raw.type)) return [];
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: PiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return [
        {
          type: 'error',
          message: 'pi stream ended before a terminal event',
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

  private translateSession(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.id);
    if (!sessionId) {
      this.drift.anomalies++;
      return [];
    }
    this.sessionId = sessionId;
    return [{ type: 'system', sessionId }];
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const event = recordValue(raw.assistantMessageEvent);
    if (!event || typeof event.type !== 'string') return [];
    if (event.type === 'text_delta') {
      const delta = stringValue(event.delta);
      return delta ? [{ type: 'text', delta }] : [];
    }
    if (event.type === 'thinking_delta') {
      const delta = stringValue(event.delta);
      return delta ? [{ type: 'thinking', delta }] : [];
    }
    if (!IGNORED_ASSISTANT_MESSAGE_EVENT_TYPES.has(event.type)) {
      this.drift.unknownEvents++;
    }
    return [];
  }

  private translateToolExecutionStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    const name = stringValue(raw.toolName);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    return [{ type: 'tool_use', id, name, input: raw.args }];
  }

  private translateToolExecutionEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const result = recordValue(raw.result);
    return [
      {
        type: 'tool_result',
        id,
        output: extractToolOutputText(result),
        isError: raw.isError === true,
      },
    ];
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(raw.message);
    if (!message || message.role !== 'assistant') return [];

    const stopReason = stringValue(message.stopReason);
    if (stopReason === 'error' || stopReason === 'aborted') {
      this.terminal = true;
      const detail = stringValue(message.errorMessage);
      return [
        {
          type: 'error',
          message: truncate(detail ?? `pi request ${stopReason}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }

    const usage = recordValue(message.usage);
    if (!usage) return [];
    const cost = recordValue(usage.cost);
    return [
      {
        type: 'usage',
        inputTokens: numberValue(usage.input),
        outputTokens: numberValue(usage.output),
        cachedInputTokens: numberValue(usage.cacheRead),
        reasoningOutputTokens: undefined,
        costUsd: numberValue(cost?.total),
      },
    ];
  }

  private translateAgentEnd(): AgentEvent[] {
    this.terminal = true;
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' }];
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

function extractToolOutputText(result: Record<string, unknown> | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
