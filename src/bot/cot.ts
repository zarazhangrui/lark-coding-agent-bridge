import type { AgentEvent } from '../agent/types';
import type { CotMessagesMode, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { toolHeaderText } from '../card/tool-render';
import type { RunState } from '../card/run-state';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const COT_UPDATE_THROTTLE_MS = 600;
const COT_TEXT_MAX = 1200;
// Atomic events cannot be split. This lower text cap keeps their content
// within the 4096-character event limit even in the worst JSON escaping case
// (`\uXXXX`, six chars per code unit).
const COT_ATOMIC_TEXT_MAX = 512;
const COT_TOOL_OUTPUT_MAX = COT_ATOMIC_TEXT_MAX;
// Request-level transport limits, measured against production Feishu with a
// bisection probe on 2026-08-17 (fresh CoT bubble per crafted PUT):
//   - Events per PUT: the server accepts exactly 50 and rejects 51+ with
//     HTTP 400 code=99992402, regardless of body size (a 51-event/6163-byte
//     request fails while a 3-event/10961-byte one passes). 32 keeps a 36%
//     margin below the measured limit.
//   - Body bytes: 32 KiB is the highest measured PASS (including 50 events
//     x 32 KiB combined); no server byte rejection was ever observed, so
//     this cap only keeps batches inside proven territory.
const COT_UPDATE_SAFE_EVENTS = 32;
const COT_UPDATE_SAFE_BYTES = 32 * 1024;
// Individual event content limit, measured exact on 2026-08-17: 4096 chars
// passes and 4097 is rejected with HTTP 200 code=10001 (AppendCOTEvents).
// Count Unicode code points so an astral character is never split.
const COT_EVENT_CONTENT_MAX_CHARS = 4096;
// Buffered deltas are split at flush time into fixed-size events. Same
// derivation as COT_ATOMIC_TEXT_MAX: 512 code points survive the worst-case
// 6-char JSON escape (3072 chars) inside the 4096-char content limit with
// ample room for the id envelope. A pathological multi-KB id would push
// content past the limit; the server then rejects the PUT (measured:
// HTTP 200 code=10001) and the publisher degrades through the normal
// failure path.
const COT_DELTA_CHUNK_CODE_POINTS = 512;
// Bounds every CoT HTTP call. Without it a hung message_cot endpoint pins
// start() — which runs before any agent event is drained and before the
// plain-reply fallback — to undici's ~300s default.
const COT_REQUEST_TIMEOUT_MS = 15_000;

export class CotClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(opts: { tenant: TenantBrand; appId: string; appSecret: string }) {
    this.baseUrl = ENDPOINTS[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const resp = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`tenant token HTTP ${resp.status}`);
    const data = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`tenant token failed: code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}`);
    }
    this.token = data.tenant_access_token;
    const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1000;
    return this.token;
  }

  async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await resp.text();
    const data = parseCotResponse(text);
    const apiCode = data && typeof data.code === 'number' ? data.code : undefined;
    const apiMessage = data && typeof data.msg === 'string' && data.msg.trim()
      ? data.msg
      : undefined;
    const ttLogId = nonEmptyString(resp.headers.get('x-tt-logid'));
    if (!resp.ok || (apiCode !== undefined && apiCode !== 0)) {
      throw new CotRequestError({
        httpStatus: resp.status,
        ...(apiCode !== undefined ? { apiCode } : {}),
        ...(apiMessage ? { apiMessage } : {}),
        ...(ttLogId ? { ttLogId } : {}),
      });
    }
    if (text.trim().length > 0 && !data) {
      throw new CotRequestError({
        httpStatus: resp.status,
        apiMessage: 'response body is not a JSON object',
        ...(ttLogId ? { ttLogId } : {}),
      });
    }
    if (!data) return {};
    return data.data ?? data;
  }

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    // message_cot only accepts receive_id_type=chat_id. thread_id is NOT a
    // valid receive type for this endpoint (it exists only on the forward
    // APIs) — addressing the create to an omt_* thread id is rejected with
    // code=10002 "Bot/User can NOT be out of the chat" (the backend tries to
    // resolve the omt_* id as a chat the bot belongs to and finds none).
    //
    // Placement inside a topic is instead governed by origin_message_id: the
    // bubble inherits the topic of the message it originates from. Passing an
    // in-topic message id keeps the bubble in the topic; the topic's root
    // (首楼) message has no thread of its own, so a bubble originated from it
    // lands at the group top level. Callers pick origin_message_id
    // accordingly.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    const body = cotUpdateBody(ref, events);
    try {
      await this.request('/open-apis/im/v1/message_cot', {
        method: 'PUT',
        body,
      });
    } catch (err) {
      log.warn('cot', 'update-request-failed', {
        err: errorMessage(err),
        ...cotRequestErrorFields(err),
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        eventStats: events.map((event) => ({
          eventType: event.event_type,
          contentBytes: Buffer.byteLength(event.content, 'utf8'),
        })),
      });
      throw err;
    }
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: 'POST',
      body: '',
    });
  }
}

interface CotRef {
  cotId: string;
  messageId: string;
}

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

type CotDeltaInput =
  | {
      eventType: 'TEXT_MESSAGE_CONTENT' | 'REASONING_MESSAGE_CONTENT';
      messageId: string;
      delta: string;
    }
  | {
      eventType: 'TOOL_CALL_ARGS';
      toolCallId: string;
      delta: string;
    };

type BufferedCotEvent =
  | { kind: 'atomic'; event: CotEvent }
  // input.delta holds the accumulated delta of all merged adjacent inputs.
  | { kind: 'delta'; input: CotDeltaInput; timestamp: number };

export interface CotRequestErrorDetails {
  httpStatus: number;
  apiCode?: number;
  apiMessage?: string;
  ttLogId?: string;
}

export class CotRequestError extends Error {
  override readonly name = 'CotRequestError';

  constructor(readonly details: CotRequestErrorDetails) {
    super([
      `COT HTTP ${details.httpStatus}`,
      ...(details.apiCode !== undefined ? [`code=${details.apiCode}`] : []),
      ...(details.apiMessage ? [`msg=${details.apiMessage}`] : []),
      ...(details.ttLogId ? [`ttLogId=${details.ttLogId}`] : []),
    ].join(' '));
  }
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  readonly runId: string;
  readonly scope: string;
  readonly inputPreview: string;
  ref: CotRef | undefined;
  // Lifecycle invariants (all mutations go through start/finish/markDegraded):
  //   disabled=true  ⇒ accepting=false and pending is empty;
  //   ref=undefined  ⇒ nothing was ever buffered (enqueue* require ref).
  disabled = false;
  degradedReason: string | undefined;
  // Buffered logical events. Deltas stay unsplit strings here; drain() swaps
  // the whole array out before materializing wire events, so a tail-merge can
  // never mutate a batch that is already serialized into an in-flight PUT.
  private pending: BufferedCotEvent[] = [];
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private accepting = true;
  private finishPromise: Promise<void> | undefined;

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    runId: string;
    scope: string;
    inputPreview: string;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.inputPreview = opts.inputPreview;
  }

  async start(): Promise<void> {
    if (!this.accepting || this.disabled) return;
    // Single chat_id-addressed create. In topics the bubble follows
    // originMessageId's thread (see CotClient.create); the caller passes an
    // in-topic origin so it lands in the topic. On any failure we disable CoT
    // and let the caller fall back to a plain reply — never retry, since a
    // create that failed after committing server-side would leave a duplicate
    // bubble spinning forever.
    let created: Record<string, unknown>;
    try {
      created = await this.client.create(this.chatId, this.originMessageId);
    } catch (err) {
      this.disabled = true;
      this.accepting = false;
      log.warn('cot', 'create-failed', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    const cotId = stringValue(created.cot_id ?? created.cotId);
    const messageId = stringValue(created.message_id ?? created.messageId);
    if (!cotId || !messageId) {
      this.disabled = true;
      this.accepting = false;
      log.warn('cot', 'create-failed', {
        err: `CreateCOT missing ids: ${JSON.stringify(created).slice(0, 200)}`,
      });
      return;
    }
    this.ref = { cotId, messageId };
    log.info('cot', 'created', { cotId, messageId });
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
      // RUN_STARTED is atomic and therefore cannot be transport-split.
      input: { query: truncateCot(this.inputPreview, COT_ATOMIC_TEXT_MAX) },
    });
    this.enqueue('STEP_STARTED', {
      stepId: `step-understand-${this.runId}`,
      stepName: '理解用户问题',
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (!this.accepting || this.disabled || !this.ref) return;
    const serialized = safeStringify(content);
    if (serialized === undefined) {
      // A custom toJSON() can throw a message containing its source value;
      // keep degradation logs metadata-only.
      this.markDegraded(`COT ${eventType} content 序列化失败`);
      return;
    }
    const event: CotEvent = {
      event_type: eventType,
      content: serialized,
      timestamp: Date.now(),
    };
    const invalidReason = cotEventContentError(event);
    if (invalidReason) {
      this.markDegraded(invalidReason);
      return;
    }
    this.pending.push({ kind: 'atomic', event });
    this.scheduleFlush();
  }

  enqueueDelta(input: CotDeltaInput): void {
    if (!this.accepting || this.disabled || !this.ref || input.delta.length === 0) return;
    // Deltas are buffered as plain strings; splitting into fixed-size events
    // happens once, at flush time. Merging adjacent deltas for the same
    // target is therefore unconditional here.
    const tail = this.pending[this.pending.length - 1];
    const merged = tail ? mergeCotDeltaInput(tail, input) : undefined;
    if (merged) {
      this.pending[this.pending.length - 1] = merged;
    } else {
      this.pending.push({ kind: 'delta', input: { ...input }, timestamp: Date.now() });
    }
    this.scheduleFlush();
  }

  async finish(reason: string): Promise<void> {
    if (!this.finishPromise) {
      // Closing intake before draining makes the queue finite and guarantees
      // complete is never raced by a late event.
      this.accepting = false;
      this.clearFlushTimer();
      this.finishPromise = this.finishAndComplete(reason);
    }
    await this.finishPromise;
  }

  private async finishAndComplete(reason: string): Promise<void> {
    // A flush may have observed an empty queue just before finish closed
    // intake. Re-check until the now-stable pending queue is fully drained.
    do {
      await this.flush();
    } while (!this.disabled && this.pending.length > 0);
    if (this.disabled || !this.ref) return;
    try {
      await this.client.complete(this.ref, reason);
      log.info('cot', 'completed', { cotId: this.ref.cotId, reason });
    } catch (err) {
      log.warn('cot', 'complete-failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private scheduleFlush(): void {
    if (!this.accepting || this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  private flush(): Promise<void> {
    if (this.disabled || !this.ref || this.pending.length === 0) {
      return this.flushing ?? Promise.resolve();
    }
    if (this.flushing) return this.flushing;
    const ref = this.ref;
    const operation = this.drain(ref)
      .catch((err) => {
        this.markDegraded(errorMessage(err));
      })
      .finally(() => {
        if (this.flushing === operation) this.flushing = undefined;
        if (this.pending.length > 0 && !this.disabled) this.scheduleFlush();
      });
    this.flushing = operation;
    return operation;
  }

  private async drain(ref: CotRef): Promise<void> {
    // Freeze this flush window. Events arriving while a PUT is in flight stay
    // pending for the next throttled window (finish drains that final window
    // immediately after closing intake). Buffered deltas are split into
    // fixed-size wire events here, exactly once per logical delta.
    const drainQueue = this.pending;
    this.pending = [];
    const wireQueue: CotEvent[] = [];
    for (const buffered of drainQueue) wireQueue.push(...wireCotEvents(buffered));
    while (!this.disabled && wireQueue.length > 0) {
      const batch = wireQueue.splice(0, cotTransportBatchLength(ref, wireQueue));
      // No retry on failure: the batch limits sit inside the probe-measured
      // server acceptance zone, so a rejection means something is genuinely
      // wrong, and a timeout/transport/5xx result might have committed
      // server-side where a retry would duplicate events. flush() degrades.
      await this.client.update(ref, batch);
    }
  }

  private markDegraded(reason: string): void {
    this.disabled = true;
    this.accepting = false;
    this.degradedReason = reason;
    this.pending = [];
    this.clearFlushTimer();
    log.warn('cot', 'update-failed', { err: reason });
  }

  private clearFlushTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.finalText
      ? [{ kind: 'text', content: state.finalText, streaming: false }]
      : state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode },
): Promise<void> {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;

  try {
    for await (const evt of events) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue('REASONING_START', { messageId: reasoningMessageId });
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueueDelta({
          eventType: 'REASONING_MESSAGE_CONTENT',
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title,
          toolCallName: showSummary ? evt.name : 'tool',
        });
        if (detailed && evt.input !== undefined) {
          const serializedInput = safeStringify(evt.input);
          if (serializedInput !== undefined) {
            publisher.enqueueDelta({
              eventType: 'TOOL_CALL_ARGS',
              toolCallId,
              // Same display cap as text/reasoning deltas. Without it a huge
              // Write-style input floods one drain window with dozens of PUTs.
              delta: truncateCot(serializedInput, COT_TEXT_MAX),
            });
          }
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          content: detailed
            ? truncateCot(evt.output ?? '', COT_TOOL_OUTPUT_MAX)
            : brief
              ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done')
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue('STEP_STARTED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (!textMessageId) {
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueueDelta({
          eventType: 'TEXT_MESSAGE_CONTENT',
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'final_text') continue;
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue('STEP_FINISHED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (evt.type === 'error') {
          // RUN_ERROR is atomic; keep arbitrary provider error text within the
          // same explicit display cap as other COT text.
          publisher.enqueue('RUN_ERROR', {
            message: truncateCot(evt.message, COT_ATOMIC_TEXT_MAX),
            code: evt.terminationReason ?? 'error',
          });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish('done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
    publisher.enqueue('REASONING_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageId = undefined;
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, max: number): string {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (isHighSurrogate(last) && isLowSurrogate(next)) end--;
  return `${text.slice(0, end)}...`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function mergeCotDeltaInput(
  tail: BufferedCotEvent,
  next: CotDeltaInput,
): BufferedCotEvent | undefined {
  if (tail.kind !== 'delta') return undefined;
  const prev = tail.input;
  if (prev.eventType === 'TOOL_CALL_ARGS' || next.eventType === 'TOOL_CALL_ARGS') {
    if (prev.eventType !== 'TOOL_CALL_ARGS' || next.eventType !== 'TOOL_CALL_ARGS') return undefined;
    if (prev.toolCallId !== next.toolCallId) return undefined;
  } else if (prev.eventType !== next.eventType || prev.messageId !== next.messageId) {
    return undefined;
  }
  return { ...tail, input: { ...prev, delta: prev.delta + next.delta } };
}

/** Materialize one buffered logical event into fixed-size wire events. */
function wireCotEvents(buffered: BufferedCotEvent): CotEvent[] {
  if (buffered.kind === 'atomic') return [buffered.event];
  const { input } = buffered;
  const codePoints = Array.from(input.delta);
  const events: CotEvent[] = [];
  for (let offset = 0; offset < codePoints.length; offset += COT_DELTA_CHUNK_CODE_POINTS) {
    const delta = codePoints.slice(offset, offset + COT_DELTA_CHUNK_CODE_POINTS).join('');
    const content = input.eventType === 'TOOL_CALL_ARGS'
      ? { toolCallId: input.toolCallId, delta }
      : { messageId: input.messageId, delta };
    events.push({
      event_type: input.eventType,
      content: JSON.stringify(content),
      timestamp: buffered.timestamp,
    });
  }
  return events;
}

function cotTransportBatchLength(ref: CotRef, events: readonly CotEvent[]): number {
  // Exact incremental byte math: a serialized JSON array is its elements
  // joined by commas inside the envelope, so summing per-event bytes plus
  // separators reproduces Buffer.byteLength(cotUpdateBody(...)) without
  // re-serializing the whole request per candidate batch.
  let bodyBytes = Buffer.byteLength(cotUpdateBody(ref, []), 'utf8');
  let count = 0;
  for (const event of events) {
    if (count >= COT_UPDATE_SAFE_EVENTS) break;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + (count > 0 ? 1 : 0);
    // Always take at least one event: a single content-legal event tops out
    // near 29 KiB (4096 code points at worst-case UTF-8/escape expansion),
    // under the 32 KiB measured-pass boundary.
    if (count > 0 && bodyBytes + eventBytes > COT_UPDATE_SAFE_BYTES) break;
    bodyBytes += eventBytes;
    count++;
  }
  return count;
}

function cotEventContentError(event: CotEvent): string | undefined {
  const contentChars = Array.from(event.content).length;
  if (contentChars > COT_EVENT_CONTENT_MAX_CHARS) {
    return `COT ${event.event_type} content 超过限制：${contentChars}/${COT_EVENT_CONTENT_MAX_CHARS} chars`;
  }
  return undefined;
}

function cotUpdateBody(ref: CotRef, events: readonly CotEvent[]): string {
  return JSON.stringify({
    cot_id: ref.cotId,
    message_id: ref.messageId,
    events,
  });
}

function parseCotResponse(
  text: string,
): ({ code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>) | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function cotRequestErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof CotRequestError)) return {};
  return {
    httpStatus: error.details.httpStatus,
    apiCode: error.details.apiCode,
    apiMessage: error.details.apiMessage,
    ttLogId: error.details.ttLogId,
  };
}

function nonEmptyString(value: string | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JSON.stringify that treats every failure mode (circular refs, BigInt, a
 * throwing toJSON, or an unserializable root) as `undefined` so callers can
 * degrade without letting user-controlled error text escape into logs.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
