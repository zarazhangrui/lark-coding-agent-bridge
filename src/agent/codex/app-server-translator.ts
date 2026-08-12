import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

export type AppServerFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface AppServerProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

interface AgentMessageState {
  text: string;
  emittedText: string;
  phase?: string;
}

interface UsageState {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Translate one app-server turn into the bridge's stable AgentEvent contract. */
export class CodexAppServerEventTranslator {
  private threadId: string | undefined;
  private turnId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private finalText: string | undefined;
  private finalMessageId: string | undefined;
  private finalMessagePhase: string | undefined;
  private latestUsage: UsageState | undefined;
  private readonly messages = new Map<string, AgentMessageState>();
  private readonly startedTools = new Set<string>();
  private drift: AppServerProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  setContext(threadId: string, turnId: string): void {
    this.threadId = threadId;
    this.turnId = turnId;
  }

  translate(method: string, input: unknown): AgentEvent[] {
    if (this.terminal) return [];
    const params = recordValue(input);
    if (!params) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.matchesContext(params)) return [];

    switch (method) {
      case 'turn/started':
      case 'thread/started':
        return [];
      case 'item/started':
        return this.translateItemStarted(params);
      case 'item/completed':
        return this.translateItemCompleted(params);
      case 'item/agentMessage/delta':
        return this.translateAgentMessageDelta(params);
      case 'item/reasoning/summaryTextDelta': {
        const delta = stringValue(params.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'thread/tokenUsage/updated':
        this.captureUsage(params);
        return [];
      case 'error': {
        const error = recordValue(params.error);
        const message = stringValue(error?.message);
        if (message && params.willRetry !== true) this.lastNonTerminalError = message;
        return [];
      }
      case 'turn/completed':
        return this.translateTurnCompleted(params);
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta':
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('app-server', 'unknown-notification', { method });
        return [];
    }
  }

  finish(reason: AppServerFinishReason = 'failed', detail?: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const events = this.incompleteEvents();
    if (reason === 'failed') {
      const suffix = detail ?? this.lastNonTerminalError;
      events.push({
        type: 'error',
        message: truncate(
          suffix
            ? `codex app-server stream ended before a terminal event: ${suffix}`
            : 'codex app-server stream ended before a terminal event',
          4096,
        ),
        terminationReason: 'failed',
      });
    } else {
      events.push({ type: 'done', threadId: this.threadId, terminationReason: reason });
    }
    return events;
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [
      ...this.incompleteEvents(),
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  protocolDrift(): AppServerProtocolDriftState {
    return { ...this.drift };
  }

  private matchesContext(params: Record<string, unknown>): boolean {
    const eventThreadId = stringValue(params.threadId);
    const eventTurnId = stringValue(params.turnId ?? recordValue(params.turn)?.id);
    if (eventThreadId && this.threadId && eventThreadId !== this.threadId) {
      this.drift.anomalies++;
      return false;
    }
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) {
      this.drift.anomalies++;
      return false;
    }
    return true;
  }

  private translateAgentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!itemId || delta === undefined) {
      this.drift.anomalies++;
      return [];
    }
    const events = this.flushUnphasedFinal(itemId);
    const message = this.messages.get(itemId) ?? { text: '', emittedText: '' };
    message.text += delta;
    this.messages.set(itemId, message);
    if (delta && message.phase === 'commentary') {
      message.emittedText += delta;
      events.push({ type: 'text', delta });
    } else if (message.phase === 'final_answer' || message.phase === undefined) {
      this.setFinalCandidate(itemId, message.phase, message.text);
    }
    return events;
  }

  private translateItemStarted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    const id = stringValue(item?.id);
    const type = stringValue(item?.type);
    if (!item || !id || !type) {
      this.drift.anomalies++;
      return [];
    }
    if (type === 'agentMessage') {
      const events = this.flushUnphasedFinal(id);
      const prior = this.messages.get(id) ?? { text: '', emittedText: '' };
      const phase = stringValue(item.phase) ?? prior.phase;
      const text = prior.text || stringValue(item.text) || '';
      const next: AgentMessageState = { ...prior, text, ...(phase ? { phase } : {}) };
      this.messages.set(id, next);
      if (phase === 'commentary') {
        events.push(...this.emitCommentarySuffix(next));
        if (this.finalMessageId === id) this.clearFinalCandidate();
      } else if (phase === 'final_answer' || phase === undefined) {
        this.setFinalCandidate(id, phase, text);
      }
      return events;
    }
    const events = this.flushUnphasedFinal();
    const tool = toolFromItem(item);
    if (!tool) return events;
    this.startedTools.add(id);
    events.push({ type: 'tool_use', id, name: tool.name, input: tool.input });
    return events;
  }

  private translateItemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    const id = stringValue(item?.id);
    const type = stringValue(item?.type);
    if (!item || !id || !type) {
      this.drift.anomalies++;
      return [];
    }
    if (type === 'agentMessage') return this.completeAgentMessage(id, item);

    const events = this.flushUnphasedFinal();
    const tool = toolFromItem(item);
    if (!tool) return events;
    if (!this.startedTools.has(id)) {
      this.drift.anomalies++;
      events.push({ type: 'tool_use', id, name: tool.name, input: tool.input });
    }
    this.startedTools.delete(id);
    events.push({
      type: 'tool_result',
      id,
      output: toolOutput(item),
      isError: toolFailed(item),
    });
    return events;
  }

  private completeAgentMessage(id: string, item: Record<string, unknown>): AgentEvent[] {
    const completedText = stringValue(item.text) ?? '';
    const events = this.flushUnphasedFinal(id);
    const state = this.messages.get(id) ?? { text: '', emittedText: '' };
    const phase = stringValue(item.phase) ?? state.phase;
    const authoritativeText = completedText || state.text;
    state.text = authoritativeText;
    if (phase) state.phase = phase;
    this.messages.set(id, state);
    if (phase === 'commentary') {
      events.push(...this.emitCommentarySuffix(state));
      if (this.finalMessageId === id) this.clearFinalCandidate();
    } else if (authoritativeText) {
      this.setFinalCandidate(id, phase, authoritativeText);
    }
    return events;
  }

  private emitCommentarySuffix(state: AgentMessageState): AgentEvent[] {
    if (!state.text || state.text === state.emittedText) return [];
    if (!state.text.startsWith(state.emittedText)) {
      this.drift.anomalies++;
      return [];
    }
    const suffix = state.text.slice(state.emittedText.length);
    state.emittedText = state.text;
    return suffix ? [{ type: 'text', delta: suffix }] : [];
  }

  private flushUnphasedFinal(exceptId?: string): AgentEvent[] {
    if (
      !this.finalMessageId ||
      this.finalMessagePhase !== undefined ||
      this.finalMessageId === exceptId
    ) return [];
    const state = this.messages.get(this.finalMessageId);
    const events = state ? this.emitCommentarySuffix(state) : [];
    this.clearFinalCandidate();
    return events;
  }

  private setFinalCandidate(id: string, phase: string | undefined, text: string): void {
    this.finalMessageId = id;
    this.finalMessagePhase = phase;
    this.finalText = text || undefined;
  }

  private clearFinalCandidate(): void {
    this.finalText = undefined;
    this.finalMessageId = undefined;
    this.finalMessagePhase = undefined;
  }

  private captureUsage(params: Record<string, unknown>): void {
    const tokenUsage = recordValue(params.tokenUsage);
    const last = recordValue(tokenUsage?.last);
    if (!last) {
      this.drift.anomalies++;
      return;
    }
    this.latestUsage = {
      inputTokens: numberValue(last.inputTokens),
      outputTokens: numberValue(last.outputTokens),
      cachedInputTokens: numberValue(last.cachedInputTokens),
      reasoningOutputTokens: numberValue(last.reasoningOutputTokens),
    };
  }

  private translateTurnCompleted(params: Record<string, unknown>): AgentEvent[] {
    const turn = recordValue(params.turn);
    const status = stringValue(turn?.status);
    if (!turn || !status || status === 'inProgress') {
      this.drift.anomalies++;
      return [];
    }
    this.terminal = true;
    if (status === 'completed') {
      const events = this.finalEvents();
      events.push({ type: 'done', threadId: this.threadId, terminationReason: 'normal' });
      return events;
    }
    const events = this.incompleteEvents();
    if (status === 'interrupted') {
      events.push({ type: 'done', threadId: this.threadId, terminationReason: 'interrupted' });
      return events;
    }
    const error = recordValue(turn.error);
    events.push({
      type: 'error',
      message: truncate(
        stringValue(error?.message) ?? this.lastNonTerminalError ?? 'codex turn failed',
        4096,
      ),
      terminationReason: 'failed',
    });
    return events;
  }

  private finalEvents(): AgentEvent[] {
    const events = this.unclosedToolEvents();
    if (this.finalText) events.push({ type: 'final_text', content: this.finalText });
    if (this.latestUsage) events.push({ type: 'usage', ...this.latestUsage });
    return events;
  }

  private incompleteEvents(): AgentEvent[] {
    const events = this.unclosedToolEvents();
    if (this.finalText) events.push({ type: 'text', delta: this.finalText });
    if (this.latestUsage) events.push({ type: 'usage', ...this.latestUsage });
    return events;
  }

  private unclosedToolEvents(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const id of this.startedTools) {
      // Keep the bridge's tool bookkeeping balanced when a process dies or a
      // turn is interrupted between item/started and item/completed.
      events.push({
        type: 'tool_result',
        id,
        output: 'codex app-server turn ended before tool completion',
        isError: true,
      });
    }
    this.startedTools.clear();
    return events;
  }
}

function toolFromItem(item: Record<string, unknown>): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: {
          command: stringValue(item.command) ?? '',
          cwd: stringValue(item.cwd) ?? '',
          ...(Array.isArray(item.commandActions) ? { commandActions: item.commandActions } : {}),
        },
      };
    case 'fileChange':
      return { name: 'FileChange', input: { changes: item.changes ?? [] } };
    case 'mcpToolCall':
      return {
        name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('/') || 'MCP',
        input: item.arguments,
      };
    case 'dynamicToolCall':
      return {
        name: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join('/') || 'Tool',
        input: item.arguments,
      };
    case 'collabAgentToolCall':
      return {
        name: stringValue(item.tool) ?? 'Agent',
        input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model },
      };
    case 'webSearch':
      return { name: 'WebSearch', input: { query: stringValue(item.query) ?? '' } };
    case 'imageView':
      return { name: 'ViewImage', input: { path: stringValue(item.path) ?? '' } };
    case 'imageGeneration':
      return { name: 'ImageGeneration', input: { revisedPrompt: item.revisedPrompt } };
    default:
      return undefined;
  }
}

function toolOutput(item: Record<string, unknown>): string {
  switch (item.type) {
    case 'commandExecution':
      return stringValue(item.aggregatedOutput) ?? '';
    case 'fileChange':
      return stringifyValue({ status: item.status, changes: item.changes });
    case 'mcpToolCall':
      return stringifyValue(item.error ?? item.result ?? '');
    case 'dynamicToolCall':
      return stringifyValue(item.contentItems ?? { success: item.success });
    case 'collabAgentToolCall':
      return stringifyValue({ status: item.status, agentsStates: item.agentsStates });
    case 'webSearch':
      return stringifyValue(item.results ?? '');
    case 'imageView':
      return stringValue(item.path) ?? '';
    case 'imageGeneration':
      return stringValue(item.result) ?? stringValue(item.savedPath) ?? '';
    default:
      return '';
  }
}

function toolFailed(item: Record<string, unknown>): boolean {
  const status = stringValue(item.status);
  if (status === 'failed' || status === 'declined') return true;
  const exitCode = numberValue(item.exitCode);
  if (exitCode !== undefined && exitCode !== 0) return true;
  if (item.type === 'mcpToolCall' && item.error != null) return true;
  if (item.type === 'dynamicToolCall' && item.success === false) return true;
  return false;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
