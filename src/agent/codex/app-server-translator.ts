import type { AgentEvent } from '../types';
import { nonEmptyString, recordValue } from './app-server-normalizer';

type AgentMessagePhase = 'commentary' | 'final_answer' | 'unknown';

export class AppServerEventTranslator {
  private readonly commandOutput = new Map<string, string>();
  private readonly startedCommands = new Set<string>();
  private readonly itemDelta = new Map<string, string>();
  private readonly itemPhase = new Map<string, AgentMessagePhase>();
  private readonly streamedCommentary = new Set<string>();
  private finalMessage: string | undefined;

  agentMessageDelta(params: Record<string, unknown> | undefined): AgentEvent[] {
    const itemId = nonEmptyString(params?.itemId);
    const delta = nonEmptyText(params?.delta);
    if (!itemId || !delta) return [];
    this.itemDelta.set(itemId, `${this.itemDelta.get(itemId) ?? ''}${delta}`);
    if (this.itemPhase.get(itemId) !== 'commentary') return [];
    this.streamedCommentary.add(itemId);
    return [{ type: 'text', delta }];
  }

  reasoningDelta(params: Record<string, unknown> | undefined): AgentEvent[] {
    const delta = nonEmptyText(params?.delta);
    return delta ? [{ type: 'thinking', delta }] : [];
  }

  itemStarted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    const type = nonEmptyString(item.type);
    const id = nonEmptyString(item.id);
    if (!type || !id) return [];
    if (type === 'agentMessage') {
      this.itemPhase.set(id, messagePhase(item.phase));
      return [];
    }
    if (type !== 'commandExecution') return [];
    this.startedCommands.add(id);
    return [{
      type: 'tool_use',
      id,
      name: 'command_execution',
      input: commandInput(item),
    }];
  }

  commandOutputDelta(params: Record<string, unknown> | undefined): void {
    const itemId = nonEmptyString(params?.itemId);
    const delta = typeof params?.delta === 'string' ? params.delta : undefined;
    if (!itemId || delta === undefined) return;
    this.commandOutput.set(itemId, `${this.commandOutput.get(itemId) ?? ''}${delta}`);
  }

  itemCompleted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    const type = nonEmptyString(item.type);
    const id = nonEmptyString(item.id);
    if (!type || !id) return [];
    if (type === 'agentMessage') return this.agentMessageCompleted(id, item);
    if (type !== 'commandExecution') return [];

    const events: AgentEvent[] = [];
    if (!this.startedCommands.delete(id)) {
      events.push({
        type: 'tool_use',
        id,
        name: 'command_execution',
        input: commandInput(item),
      });
    }
    const aggregate = typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : this.commandOutput.get(id) ?? '命令未返回输出';
    this.commandOutput.delete(id);
    const exitCode = finiteNumber(item.exitCode);
    const status = nonEmptyString(item.status);
    events.push({
      type: 'tool_result',
      id,
      output: aggregate,
      isError: status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0),
    });
    return events;
  }

  usageUpdated(params: Record<string, unknown> | undefined): AgentEvent[] {
    const usage = recordValue(recordValue(params?.tokenUsage)?.last);
    if (!usage) return [];
    return [{
      type: 'usage',
      inputTokens: finiteNumber(usage.inputTokens),
      outputTokens: finiteNumber(usage.outputTokens),
      cachedInputTokens: finiteNumber(usage.cachedInputTokens),
      reasoningOutputTokens: finiteNumber(usage.reasoningOutputTokens),
    }];
  }

  takeFinalMessage(): string | undefined {
    const message = this.finalMessage;
    this.finalMessage = undefined;
    return message;
  }

  private agentMessageCompleted(
    id: string,
    item: Record<string, unknown>,
  ): AgentEvent[] {
    const text = nonEmptyString(item.text);
    const phase = messagePhase(item.phase, this.itemPhase.get(id));
    const streamed = this.itemDelta.get(id);
    const completedText = text ?? (streamed ? nonEmptyText(streamed) : undefined);
    const events: AgentEvent[] = [];
    if (completedText && phase === 'commentary' && !this.streamedCommentary.has(id)) {
      events.push({ type: 'text', delta: completedText });
    }
    if (completedText && phase !== 'commentary') this.finalMessage = completedText;
    this.itemDelta.delete(id);
    this.itemPhase.delete(id);
    this.streamedCommentary.delete(id);
    return events;
  }
}

function commandInput(item: Record<string, unknown>): Record<string, string> {
  const command = nonEmptyString(item.command);
  const cwd = nonEmptyString(item.cwd);
  return {
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function messagePhase(value: unknown, fallback: AgentMessagePhase = 'unknown'): AgentMessagePhase {
  return value === 'commentary' || value === 'final_answer' ? value : fallback;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
