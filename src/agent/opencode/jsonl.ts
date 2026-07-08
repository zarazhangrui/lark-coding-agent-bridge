import type { AgentEvent } from '../types';

export type OpenCodeFinishReason = 'failed' | 'interrupted' | 'timeout';

export class OpenCodeJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];
    const sessionEvent = this.captureSessionId(raw);

    switch (raw.type) {
      case 'session.started':
      case 'step_start':
        return sessionEvent;
      case 'text':
        return [...sessionEvent, ...this.translateText(raw)];
      case 'tool_use':
        return [...sessionEvent, ...this.translateToolUse(raw)];
      case 'tool_result':
        return [...sessionEvent, ...this.translateToolResult(raw)];
      case 'step_finish':
        return [...sessionEvent, ...this.translateStepFinish(raw)];
      default:
        return sessionEvent;
    }
  }

  finish(reason: OpenCodeFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return [
        {
          type: 'error',
          message: 'opencode stream ended before a terminal event',
          terminationReason: 'failed',
        },
      ];
    }
    return [
      {
        type: 'done',
        terminationReason: reason,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    ];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private captureSessionId(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.session_id ?? raw.sessionId ?? raw.sessionID);
    if (!sessionId || sessionId === this.sessionId) return [];
    this.sessionId = sessionId;
    return [{ type: 'system', sessionId }];
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const text = stringValue(raw.text) ?? stringValue(recordValue(raw.part)?.text);
    return text ? [{ type: 'text', delta: text }] : [];
  }

  private translateToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const tool = stringValue(raw.tool) ?? stringValue(part?.tool) ?? stringValue(part?.name);
    if (!tool) return [];
    const id =
      stringValue(raw.callID ?? raw.callId ?? raw.id ?? part?.callID ?? part?.callId ?? part?.id) ??
      tool;
    const state = recordValue(raw.state) ?? recordValue(part?.state);
    const input = raw.input ?? part?.input ?? state?.input ?? {};
    const events: AgentEvent[] = [{ type: 'tool_use', id, name: tool, input }];

    const status = stringValue(raw.status ?? part?.status ?? state?.status);
    const output = stringValue(raw.output ?? part?.output ?? state?.output);
    if (status === 'completed') {
      events.push({
        type: 'tool_result',
        id,
        output: output ?? fallbackToolOutput(state),
        isError: false,
      });
    }
    return events;
  }

  private translateToolResult(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.callID ?? raw.callId ?? raw.id);
    if (!id) return [];
    return [
      {
        type: 'tool_result',
        id,
        output: stringValue(raw.output) ?? '',
        isError: raw.error === true,
      },
    ];
  }

  private translateStepFinish(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const reason = stringValue(raw.reason ?? part?.reason);
    if (reason === 'tool-calls') return [];
    this.terminal = true;
    return [
      {
        type: 'done',
        terminationReason: 'normal',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    ];
  }
}

function fallbackToolOutput(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  const title = stringValue(state.title);
  if (title) return title;
  const metadata = recordValue(state.metadata);
  return stringValue(metadata?.filepath) ?? '';
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
