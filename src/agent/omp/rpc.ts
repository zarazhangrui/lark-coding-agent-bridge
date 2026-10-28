import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_CHARS = 4096;

interface ChunkFrame {
  type: 'rpc_chunk';
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface PendingChunks {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
}

/**
 * Reassembles OMP RPC protocol-v2 `rpc_chunk` frames into the logical frame
 * they encode. Before negotiation (or on protocol v1) every stdout line is a
 * complete frame and is returned as-is.
 *
 * Validation follows the protocol contract: chunk metadata must be
 * consistent, indexes contiguous, the declared byte length must match the
 * decoded payload, and the payload must decode as strict UTF-8 JSON.
 */
export class OmpRpcFrameDecoder {
  private maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
  private pending: PendingChunks | undefined;

  setMaxReassembledBytes(value: unknown): void {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      this.maxReassembledBytes = value;
    }
  }

  decode(line: string): unknown | undefined {
    const frame = JSON.parse(line) as unknown;
    if (!isChunkFrame(frame)) {
      if (this.pending) throw new Error('OMP RPC chunk sequence was interrupted');
      return frame;
    }

    if (frame.count < 1 || frame.index < 0 || frame.index >= frame.count) {
      throw new Error('OMP RPC chunk metadata is invalid');
    }
    if (frame.byteLength < 0 || frame.byteLength > this.maxReassembledBytes) {
      throw new Error('OMP RPC reassembled frame exceeds the advertised limit');
    }
    if (!isBase64(frame.data)) throw new Error('OMP RPC chunk data is not valid base64');

    if (!this.pending) {
      if (frame.index !== 0) throw new Error('OMP RPC chunk sequence did not start at index 0');
      this.pending = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
      };
    }

    const pending = this.pending;
    if (
      frame.chunkId !== pending.id ||
      frame.count !== pending.count ||
      frame.byteLength !== pending.byteLength ||
      frame.index !== pending.parts.length
    ) {
      throw new Error('OMP RPC chunk sequence is inconsistent');
    }

    pending.parts.push(Buffer.from(frame.data, 'base64'));
    if (pending.parts.length !== pending.count) return undefined;

    const payload = Buffer.concat(pending.parts);
    this.pending = undefined;
    if (payload.byteLength !== pending.byteLength) {
      throw new Error('OMP RPC chunk byte length does not match its declaration');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  }
}

export type OmpFinishReason = 'normal' | 'interrupted' | 'timeout' | 'failed';

export interface OmpProtocolDrift {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates OMP RPC stdout frames into the bridge's `AgentEvent` contract.
 *
 * A run is terminal at `prompt_result` (the agent yielded), not at
 * `agent_end`: OMP can keep a session alive for background work after a turn,
 * and the bridge run represents exactly one chat turn.
 */
export class OmpRpcTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastError: string | undefined;
  private sawAgentEnd = false;
  private textStreamed = false;
  private thinkingStreamed = false;
  private commandTextStarted = false;
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private readonly drift: OmpProtocolDrift = { unknownEvents: 0, anomalies: 0 };

  translate(frame: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(frame) || typeof frame.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (frame.type) {
      case 'response':
        return this.translateResponse(frame);
      case 'message_start':
        this.resetMessageStreaming(frame);
        return [];
      case 'message_update':
        return this.translateMessageUpdate(frame);
      case 'message_end':
        return this.translateMessageEnd(frame);
      case 'tool_execution_start':
        return this.translateToolStart(frame);
      case 'tool_execution_end':
        return this.translateToolEnd(frame);
      case 'prompt_result':
        return this.translatePromptResult(frame);
      case 'agent_end':
        this.sawAgentEnd = frame.yielded !== false;
        return [];
      case 'command_output': {
        const output = resultText(frame.output ?? frame.content ?? frame.message);
        if (!output) return [];
        this.commandTextStarted = true;
        return [{ type: 'text', delta: output }];
      }
      case 'tool_execution_update':
      case 'ready':
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'session_settled':
      case 'queue_update':
      case 'available_commands_update':
      case 'session_info_update':
      case 'config_update':
      case 'model_changed':
      case 'thinking_level_changed':
      case 'todo_reminder':
      case 'ttsr_triggered':
      case 'irc_message':
      case 'goal_updated':
      case 'auto_compaction_start':
      case 'auto_compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'retry_fallback_applied':
      case 'retry_fallback_succeeded':
      case 'advisor_cost_changed':
      case 'extension_ui_request':
      case 'notice':
        return [];
      case 'rpc_frame_error': {
        const message = stringValue(frame.error ?? frame.message) ?? 'OMP RPC frame overflow';
        return this.fail(message);
      }
      case 'extension_error':
        log.warn('omp', 'extension-error', {
          extensionPath: stringValue(frame.extensionPath) ?? null,
          event: stringValue(frame.event) ?? null,
          error: stringValue(frame.error) ?? null,
        });
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { agent: 'omp', eventType: frame.type });
        return [];
    }
  }

  finish(reason: OmpFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastError ? `: ${this.lastError}` : '';
      return [
        {
          type: 'error',
          message: truncate(`omp stream ended before a terminal event${detail}`, MAX_ERROR_CHARS),
          terminationReason: 'failed',
        },
      ];
    }
    return [
      {
        type: 'done',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        terminationReason: reason,
      },
    ];
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    this.lastError = message;
    return [
      {
        type: 'error',
        message: truncate(message, MAX_ERROR_CHARS),
        terminationReason: 'failed',
      },
    ];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  endedAfterAgentYield(): boolean {
    return this.sawAgentEnd;
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  protocolDrift(): OmpProtocolDrift {
    return { ...this.drift };
  }

  private resetMessageStreaming(frame: Record<string, unknown>): void {
    const message = recordValue(frame.message);
    if (message?.role !== 'assistant') return;
    this.textStreamed = false;
    this.thinkingStreamed = false;
  }

  private translateMessageUpdate(frame: Record<string, unknown>): AgentEvent[] {
    const update = recordValue(frame.assistantMessageEvent);
    if (!update) return [];
    const delta = stringValue(update.delta);
    switch (update.type) {
      case 'text_delta':
        if (!delta) return [];
        this.textStreamed = true;
        return [{ type: 'text', delta }];
      case 'thinking_delta':
        if (!delta) return [];
        this.thinkingStreamed = true;
        return [{ type: 'thinking', delta }];
      default:
        return [];
    }
  }

  private translateMessageEnd(frame: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(frame.message);
    if (!message) return [];
    const role = stringValue(message.role);

    if (role === 'assistant') {
      const events: AgentEvent[] = [];
      const text = textFromContent(message.content);
      if (text && !this.textStreamed) events.push({ type: 'text', delta: text });
      if (text) events.push({ type: 'final_text', content: text });
      if (!this.thinkingStreamed) {
        const thinking = thinkingFromContent(message.content);
        if (thinking) events.push({ type: 'thinking', delta: thinking });
      }
      const usage = usageEvent(message);
      if (usage) events.push(usage);
      this.textStreamed = false;
      this.thinkingStreamed = false;
      return events;
    }

    if (role === 'toolResult') {
      const id = stringValue(message.toolCallId ?? message.tool_use_id);
      if (!id || this.finishedTools.has(id)) return [];
      const events: AgentEvent[] = [];
      if (!this.startedTools.has(id)) {
        const name = stringValue(message.toolName) ?? 'tool';
        this.startedTools.add(id);
        events.push({ type: 'tool_use', id, name, input: {} });
      }
      this.finishedTools.add(id);
      events.push({
        type: 'tool_result',
        id,
        output: textFromContent(message.content),
        isError: message.isError === true,
      });
      return events;
    }

    return [];
  }

  private translateToolStart(frame: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(frame.toolCallId ?? frame.id);
    const name = stringValue(frame.toolName ?? frame.name);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    if (this.startedTools.has(id)) return [];
    this.startedTools.add(id);
    return [
      {
        type: 'tool_use',
        id,
        name,
        input: frame.args ?? frame.arguments ?? {},
      },
    ];
  }

  private translateToolEnd(frame: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(frame.toolCallId ?? frame.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const events: AgentEvent[] = [];
    if (!this.startedTools.has(id)) {
      const name = stringValue(frame.toolName ?? frame.name) ?? 'tool';
      this.startedTools.add(id);
      events.push({
        type: 'tool_use',
        id,
        name,
        input: frame.args ?? frame.arguments ?? {},
      });
    }
    if (this.finishedTools.has(id)) return events;
    this.finishedTools.add(id);
    events.push({
      type: 'tool_result',
      id,
      output: resultText(frame.result ?? frame.output),
      isError: frame.isError === true || frame.error === true,
    });
    return events;
  }

  private translateResponse(frame: Record<string, unknown>): AgentEvent[] {
    const command = stringValue(frame.command);
    if (frame.success === false) {
      const message = stringValue(frame.error) ?? `OMP RPC ${command ?? 'command'} failed`;
      if (command === 'negotiate_protocol') {
        log.warn('omp', 'protocol-negotiation-failed', { error: message });
        return [];
      }
      return this.fail(message);
    }

    if (command === 'get_state') {
      const data = recordValue(frame.data);
      const sessionId = stringValue(data?.sessionId);
      if (sessionId) this.sessionId = sessionId;
      else this.drift.anomalies++;
      const model = recordValue(data?.model);
      const modelId = stringValue(model?.id) ?? stringValue(model?.name);
      return sessionId
        ? [
            {
              type: 'system',
              sessionId,
              ...(modelId ? { model: modelId } : {}),
            },
          ]
        : [];
    }

    if (command === 'prompt') {
      const data = recordValue(frame.data);
      if (data?.agentInvoked === false) return this.finish('normal');
    }
    return [];
  }

  private translatePromptResult(frame: Record<string, unknown>): AgentEvent[] {
    const status = stringValue(frame.status);
    if (status === 'error') {
      const error = recordValue(frame.error);
      return this.fail(
        stringValue(error?.message) ?? stringValue(frame.error) ?? 'omp prompt failed',
      );
    }
    if (status === 'aborted') return this.finish('interrupted');
    return this.finish('normal');
  }
}

function isChunkFrame(value: unknown): value is ChunkFrame {
  if (!isRecord(value) || value.type !== 'rpc_chunk') return false;
  return (
    typeof value.chunkId === 'string' &&
    typeof value.index === 'number' &&
    typeof value.count === 'number' &&
    typeof value.byteLength === 'number' &&
    typeof value.data === 'string'
  );
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text = stringValue(block.text);
    if (block.type === 'text' && text) parts.push(text);
  }
  return parts.join('');
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const thinking = stringValue(block.thinking);
    if (block.type === 'thinking' && thinking) parts.push(thinking);
  }
  return parts.join('');
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return textFromContent(value);
  const record = recordValue(value);
  if (!record) return '';
  return textFromContent(record.content);
}

function usageEvent(
  message: Record<string, unknown>,
): Extract<AgentEvent, { type: 'usage' }> | undefined {
  const usage = recordValue(message.usage);
  if (!usage) return undefined;
  const cost = recordValue(usage.cost);
  const event: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
  const inputTokens = numberValue(usage.inputTokens) ?? numberValue(usage.input);
  const outputTokens = numberValue(usage.outputTokens) ?? numberValue(usage.output);
  const cachedInputTokens =
    numberValue(usage.cacheReadTokens) ??
    numberValue(usage.cachedInputTokens) ??
    numberValue(usage.cacheRead);
  const costUsd = numberValue(cost?.total);
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) event.cachedInputTokens = cachedInputTokens;
  if (costUsd !== undefined) event.costUsd = costUsd;
  return Object.keys(event).length > 1 ? event : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
