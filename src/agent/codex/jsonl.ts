import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type CodexFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

export class CodexJsonlTranslator {
  private threadId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private pendingAgentMessage: string | undefined;
  private readonly startedItems = new Set<string>();
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
      case 'thread.started':
        return this.translateThreadStarted(raw);
      case 'turn.started':
        return [];
      case 'item.started':
        return this.prependPendingText(this.translateItemStarted(raw));
      case 'item.completed':
        return this.translateItemCompleted(raw);
      case 'agent_message':
        return this.translateAgentMessage(raw);
      case 'turn.completed':
        return this.translateTurnCompleted(raw);
      case 'turn.failed':
        return this.prependPendingText(
          this.translateTerminalError(raw, 'codex turn failed'),
        );
      case 'error':
        return this.translateNonTerminalError(raw, 'codex error');
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: CodexFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return this.prependPendingText([
        {
          type: 'error',
          message: truncate(`codex stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ]);
    }
    return this.prependPendingText([
      { type: 'done', threadId: this.threadId, terminationReason: reason },
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

  private translateThreadStarted(raw: Record<string, unknown>): AgentEvent[] {
    const threadId = stringValue(raw.thread_id ?? raw.threadId);
    if (!threadId) {
      this.drift.anomalies++;
      return [];
    }
    this.threadId = threadId;
    return [{ type: 'system', threadId }];
  }

  private translateItemStarted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item || item.type !== 'command_execution') return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    this.startedItems.add(id);
    return [
      {
        type: 'tool_use',
        id,
        name: 'command_execution',
        input: {
          command: stringValue(item.command) ?? '',
        },
      },
    ];
  }

  private translateItemCompleted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item) return [];
    if (item.type === 'agent_message') {
      const message = stringValue(item.text ?? item.message);
      return message ? this.queueAgentMessage(message) : [];
    }
    if (item.type !== 'command_execution') return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.startedItems.has(id)) {
      this.drift.anomalies++;
    }
    this.startedItems.delete(id);
    const exitCode = numberValue(item.exit_code);
    return this.prependPendingText([
      {
        type: 'tool_result',
        id,
        output: stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? '',
        isError: exitCode !== undefined && exitCode !== 0,
      },
    ]);
  }

  private translateAgentMessage(raw: Record<string, unknown>): AgentEvent[] {
    const message = stringValue(raw.message ?? raw.text);
    if (!message) return [];
    return this.queueAgentMessage(message);
  }

  private translateTurnCompleted(raw: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const events: AgentEvent[] = [];
    if (this.pendingAgentMessage) {
      events.push({ type: 'final_text', content: this.pendingAgentMessage });
      this.pendingAgentMessage = undefined;
    }
    const usage = recordValue(raw.usage);
    if (usage) {
      // No context size is reported for Codex runs. `turn.completed.usage`
      // looks like a per-turn *total* — i.e. summed over every model request
      // the turn made — which is the same trap that made the Claude footer
      // read four times high, and Codex exposes no per-request breakdown to
      // recover the last request from. Until that is verified against a real
      // multi-request turn, the footer drops the segment rather than risk a
      // confidently wrong number.
      events.push({
        type: 'usage',
        inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
        outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
        reasoningOutputTokens: numberValue(
          usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
        ),
      });
    }
    events.push({ type: 'done', threadId: this.threadId, terminationReason: 'normal' });
    return events;
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    // Codex announces the same message in more than one shape across versions
    // (a raw `agent_message` event and a completed `agent_message` item). A
    // build that emits both would otherwise stream the first copy as progress
    // commentary and then deliver the second as the final answer — the same
    // words twice. An identical repeat is the same message, not a new one.
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

  private translateTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    this.terminal = true;
    const message = errorMessage(raw, fallback);
    return [
      {
        type: 'error',
        message: truncate(message, 4096),
        terminationReason: 'failed',
      },
    ];
  }

  private translateNonTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    const message = errorMessage(raw, fallback);
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
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
  const nested = recordValue(raw.error);
  return (
    stringValue(raw.message) ??
    stringValue(nested?.message) ??
    stringValue(raw.error) ??
    fallback
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
