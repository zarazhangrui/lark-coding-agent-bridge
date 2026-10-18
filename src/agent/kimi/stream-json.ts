import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type KimiFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

/**
 * Translates Kimi Code CLI `kimi -p --output-format stream-json` NDJSON
 * events into bridge AgentEvents.
 *
 * Kimi's stream schema (verified against kimi 2.2.0):
 *   {"role":"meta","type":"system.version","version":"2.2.0"}
 *   {"role":"assistant","content":"..."}
 *   {"role":"assistant","tool_calls":[{"id":"tool_…","function":{"name":"Bash","arguments":"<json>"}}]}
 *   {"role":"tool","tool_call_id":"tool_…","content":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_…","command":"kimi -r …"}
 *
 * Unlike Claude's stream-json, the session id only arrives at end-of-run in
 * `session.resume_hint`; there is no init event carrying it. Thinking text is
 * written to stderr, never to JSONL, and there are no usage/cost events.
 */
export class KimiStreamTranslator {
  private sessionId: string | undefined;
  private version: string | undefined;
  private terminal = false;

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw)) return [];

    switch (stringValue(raw.role)) {
      case 'meta':
        return this.translateMeta(raw);
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool':
        return this.translateTool(raw);
      default:
        return [];
    }
  }

  /** kimi CLI version announced by the leading `system.version` meta line. */
  kimiVersion(): string | undefined {
    return this.version;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  /** Terminal fallback when the stream ends without a resume_hint (e.g. SIGTERM). */
  finish(reason: KimiFinishReason = 'interrupted'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return [
        {
          type: 'error',
          message: 'kimi stream ended before a terminal event',
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
    return [{ type: 'error', message: truncate(message, 4096), terminationReason: 'failed' }];
  }

  private translateMeta(raw: Record<string, unknown>): AgentEvent[] {
    const type = stringValue(raw.type);
    if (type === 'system.version') {
      this.version = stringValue(raw.version);
      log.info('agent', 'kimi-version', { version: this.version ?? null });
      return [];
    }
    if (type === 'session.resume_hint') {
      this.terminal = true;
      const sessionId = stringValue(raw.session_id);
      if (sessionId) this.sessionId = sessionId;
      const events: AgentEvent[] = [];
      // recordRunSessionEvent only consumes `system` events, but kimi reports
      // the session id at end-of-run — emit a trailing system event so the
      // session catalog can record it before `done`.
      if (sessionId) events.push({ type: 'system', sessionId });
      events.push({
        type: 'done',
        ...(sessionId ? { sessionId } : {}),
        terminationReason: 'normal',
      });
      return events;
    }
    return [];
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const content = stringValue(raw.content);
    if (content) events.push({ type: 'text', delta: content });
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call)) continue;
        const id = stringValue(call.id);
        const fn = recordValue(call.function);
        const name = fn ? stringValue(fn.name) : undefined;
        if (!id || !name) continue;
        events.push({ type: 'tool_use', id, name, input: parseToolInput(fn?.arguments) });
      }
    }
    return events;
  }

  private translateTool(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.tool_call_id);
    if (!id) return [];
    const content = raw.content;
    const output = typeof content === 'string' ? content : JSON.stringify(content) ?? '';
    return [{ type: 'tool_result', id, output, isError: false }];
  }
}

/** kimi sends tool arguments as a JSON-encoded string; decode when possible. */
function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
