import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

interface KimiToolCall {
  type?: string;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface KimiAssistantEvent {
  role: 'assistant';
  content?: string;
  tool_calls?: KimiToolCall[];
}

interface KimiToolEvent {
  role: 'tool';
  tool_call_id?: string;
  content?: unknown;
}

interface KimiMetaEvent {
  role: 'meta';
  type?: string;
  session_id?: string;
  command?: string;
  content?: string;
}

type KimiEvent = KimiAssistantEvent | KimiToolEvent | KimiMetaEvent | Record<string, unknown>;

export class KimiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw)) {
      this.drift.anomalies++;
      return [];
    }

    const role = typeof raw.role === 'string' ? raw.role : undefined;

    if (role === 'assistant') {
      return this.translateAssistantEvent(raw as unknown as KimiAssistantEvent);
    }
    if (role === 'tool') {
      return this.translateToolEvent(raw as unknown as KimiToolEvent);
    }
    if (role === 'meta') {
      return this.translateMetaEvent(raw as unknown as KimiMetaEvent);
    }

    this.drift.unknownEvents++;
    log.warn('kimi-jsonl', 'unknown_event', { role });
    return [];
  }

  finish(reason: 'normal' | 'interrupted' | 'failed' = 'normal'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return [
        {
          type: 'error',
          message: 'kimi stream ended without a terminal event',
          terminationReason: 'failed',
        },
      ];
    }
    return [
      {
        type: 'done',
        sessionId: this.sessionId,
        terminationReason: reason,
      },
    ];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateAssistantEvent(raw: KimiAssistantEvent): AgentEvent[] {
    const events: AgentEvent[] = [];

    if (typeof raw.content === 'string' && raw.content) {
      events.push({ type: 'text', delta: raw.content });
    }

    if (Array.isArray(raw.tool_calls)) {
      for (const toolCall of raw.tool_calls) {
        const id = typeof toolCall.id === 'string' ? toolCall.id : undefined;
        const name = toolCall.function?.name;
        if (!id || !name) {
          this.drift.anomalies++;
          continue;
        }
        let input: unknown;
        try {
          const args = toolCall.function?.arguments;
          input = typeof args === 'string' ? JSON.parse(args) : args;
        } catch {
          input = toolCall.function?.arguments;
        }
        events.push({ type: 'tool_use', id, name, input });
      }
    }

    return events;
  }

  private translateToolEvent(raw: KimiToolEvent): AgentEvent[] {
    const id = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined;
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const output = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '');
    return [{ type: 'tool_result', id, output, isError: false }];
  }

  private translateMetaEvent(raw: KimiMetaEvent): AgentEvent[] {
    if (raw.type === 'session.resume_hint' && typeof raw.session_id === 'string') {
      this.sessionId = raw.session_id;
      return [{ type: 'system', sessionId: raw.session_id }];
    }
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
