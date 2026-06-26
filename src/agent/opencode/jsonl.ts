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
