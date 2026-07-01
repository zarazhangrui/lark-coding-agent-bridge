import type { AgentEvent } from '../types';

export type OpenCodeFinishReason = 'failed' | 'interrupted' | 'timeout';

export class OpenCodeJsonlTranslator {
  private terminal = false;
  private lastNonTerminalError: string | undefined;

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];

    switch (raw.type) {
      case 'step_start':
        return [];
      case 'text':
        return this.translateText(raw);
      case 'tool_use':
        return this.translateToolUse(raw);
      case 'step_finish':
        return this.translateStepFinish();
      default:
        return [];
    }
  }

  finish(reason: OpenCodeFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return [
        {
          type: 'error',
          message: truncate(`opencode stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'done', terminationReason: reason }];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = part ? stringValue(part.text) : undefined;
    return text ? [{ type: 'text', delta: text }] : [];
  }

  private translateStepFinish(): AgentEvent[] {
    this.terminal = true;
    return [{ type: 'done', terminationReason: 'normal' }];
  }

  private translateToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part || part.type !== 'tool') return [];
    const tool = stringValue(part.tool);
    if (!tool) return [];
    const callId = stringValue(part.callID);
    const id = callId ?? tool;
    const state = recordValue(part.state);
    const input = state ? state.input : undefined;
    const output = state ? stringValue(state.output) : undefined;
    const status = state ? stringValue(state.status) : undefined;

    const events: AgentEvent[] = [
      { type: 'tool_use', id, name: tool, input: input ?? {} },
    ];

    if (status === 'completed') {
      const fallbackOutput = fallbackToolOutput(state);
      events.push({
        type: 'tool_result',
        id,
        output: output ?? fallbackOutput,
        isError: false,
      });
    }

    return events;
  }
}

function fallbackToolOutput(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  const title = stringValue(state.title);
  if (title) return title;
  const metadata = recordValue(state.metadata);
  const filepath = metadata ? stringValue(metadata.filepath) : undefined;
  return filepath ?? '';
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

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
