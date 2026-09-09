import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import type { SandboxMode } from '../../config/profile-schema';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import type { AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import pkg from '../../../package.json';

type Child = SpawnedProcessByStdio<Writable, Readable, Readable>;
type Json = Record<string, unknown>;

export interface CodexAppServerRuntimeOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome: boolean;
  sandbox: SandboxMode;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  larkChannel?: LarkChannelEnvContext;
  getBotIdentity: () => AgentBotIdentity | undefined;
}

/**
 * One bridge profile owns one proxy connection. The daemon remains user-owned:
 * we may start it, but never stop it during bridge shutdown.
 */
export class CodexAppServerRuntime {
  private readonly options: CodexAppServerRuntimeOptions;
  private client: AppServerClient | undefined;

  constructor(options: CodexAppServerRuntimeOptions) {
    this.options = options;
  }

  run(options: AgentRunOptions): AgentRun {
    if (!options.cwd) throw new Error('cwd is required for Codex app-server run');
    const stream = new EventQueue();
    let threadId = options.threadId;
    let turnId: string | undefined;
    let terminal = false;
    let stopped = false;
    let connected: AppServerClient | undefined;
    const translator = new AppServerTurnTranslator();

    const emit = (event: AgentEvent): void => {
      if (terminal) return;
      if (event.type === 'done' || event.type === 'error') terminal = true;
      stream.push(event);
      if (terminal) stream.close();
    };

    void (async () => {
      try {
        connected = this.client ??= new AppServerClient(this.options);
        await connected.connect();
        const start = threadId
          ? await connected.request('thread/resume', {
              threadId,
              cwd: options.cwd,
              model: options.model,
              config: this.threadConfig(),
              developerInstructions: buildBridgeSystemPrompt(this.options.getBotIdentity()),
            })
          : await connected.request('thread/start', {
              cwd: options.cwd,
              model: options.model,
              sandbox: options.sandbox ?? this.options.sandbox,
              approvalPolicy: 'never',
              config: this.threadConfig(),
              developerInstructions: buildBridgeSystemPrompt(this.options.getBotIdentity()),
            });
        threadId = threadIdFrom(start) ?? threadId;
        if (!threadId) throw new Error('app-server response did not contain a thread id');
        emit({ type: 'system', threadId, cwd: options.cwd });
        const unsubscribe = connected.subscribe(threadId, (message) => {
          for (const event of translator.translate(message)) emit(event);
        });
        try {
          const turn = await connected.request('turn/start', {
            threadId,
            cwd: options.cwd,
            approvalPolicy: 'never',
            input: [
              { type: 'text', text: options.prompt },
              ...(options.images ?? []).map((path) => ({ type: 'localImage', path })),
            ],
            clientUserMessageId: options.runId,
          });
          turnId = stringAt(turn, 'turn', 'id') ?? stringAt(turn, 'id');
          if (stopped && turnId) await connected.request('turn/interrupt', { threadId, turnId });
        } finally {
          // The terminal notification is delivered before this is removed. A
          // failed request has no turn to observe and is handled by catch.
          if (terminal) unsubscribe();
          else stream.onClose(unsubscribe);
        }
      } catch (error) {
        emit({
          type: 'error',
          message: `codex app-server error: ${errorMessage(error)}`,
          terminationReason: stopped ? 'interrupted' : 'failed',
        });
      }
    })();

    return {
      runId: options.runId,
      events: stream,
      async stop() {
        stopped = true;
        if (connected && threadId && turnId && !terminal) {
          try {
            await connected.request('turn/interrupt', { threadId, turnId });
          } catch (error) {
            log.warn('codex-app-server', 'interrupt-failed', { message: errorMessage(error) });
          }
        }
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        return stream.waitForClose(timeoutMs);
      },
    };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  /**
   * The app-server daemon is long-lived, so the bridge process environment is
   * not inherited by its tool processes. Put bridge-bound variables in each
   * thread's shell policy instead. This is also applied on resume so existing
   * Lark conversations recover without needing to discard their session.
   */
  private threadConfig(): Json {
    return {
      shell_environment_policy: {
        inherit: 'all',
        set: buildLarkChannelEnv(this.options.larkChannel),
      },
      ...(this.options.reasoningEffort
        ? { model_reasoning_effort: this.options.reasoningEffort }
        : {}),
    };
  }
}

class AppServerClient {
  private readonly options: CodexAppServerRuntimeOptions;
  private child: Child | undefined;
  private upgrade: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private readBuffer = Buffer.alloc(0);
  private fragment: { opcode: number; chunks: Buffer[] } | undefined;
  private nextId = 1;
  private connecting: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private readonly subscribers = new Map<string, Set<(message: Json) => void>>();

  constructor(options: CodexAppServerRuntimeOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.child?.exitCode === null && this.child.signalCode === null) return;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async request(method: string, params: Json): Promise<Json> {
    await this.connect();
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: Json): Promise<Json> {
    const child = this.child;
    if (!child) throw new Error('app-server proxy is unavailable');
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeFrame(0x1, Buffer.from(message, 'utf8'), (error?: Error | null) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  subscribe(threadId: string, callback: (message: Json) => void): () => void {
    const callbacks = this.subscribers.get(threadId) ?? new Set();
    callbacks.add(callback);
    this.subscribers.set(threadId, callbacks);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.subscribers.delete(threadId);
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.fail(new Error('app-server proxy closed by bridge'));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  private async open(): Promise<void> {
    await this.startDaemon();
    const child = this.spawn(['app-server', 'proxy']);
    this.child = child;
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      this.fail(new Error(`app-server proxy exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail.slice(0, 500)}` : ''}`));
    });
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    const upgraded = new Promise<void>((resolve, reject) => {
      this.upgrade = { resolve, reject };
    });
    child.stdin.write(this.upgradeRequest(), 'utf8', (error?: Error | null) => {
      if (error) this.fail(error);
    });
    await upgraded;
    await this.sendRequest('initialize', {
      clientInfo: { name: 'lark-channel-bridge', title: 'Lark Channel Bridge', version: pkg.version },
      capabilities: null,
    });
  }

  private async startDaemon(): Promise<void> {
    const child = this.spawn(['app-server', 'daemon', 'start']);
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          const hint = /managed standalone Codex install not found/i.test(detail)
            ? ' Codex app-server daemon requires the standalone Codex installation; install it with the Codex installer, then restart the bridge.'
            : '';
          reject(new Error(`app-server daemon start failed (${code ?? 'signal'}): ${detail}${hint}`));
        }
      });
    });
  }

  private spawn(args: string[]): Child {
    const envOverrides = buildLarkChannelEnv(this.options.larkChannel);
    if (this.options.codexHome) envOverrides.CODEX_HOME = this.options.codexHome;
    else if (!this.options.inheritCodexHome) envOverrides.CODEX_HOME = join(this.options.profileStateDir, 'codex-home');
    return spawnProcess(this.options.binary, args, {
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as Child;
  }

  private upgradeRequest(): string {
    const key = randomBytes(16).toString('base64');
    return [
      'GET / HTTP/1.1',
      'Host: localhost',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      '',
      '',
    ].join('\r\n');
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    if (this.upgrade) {
      const boundary = this.readBuffer.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      const response = this.readBuffer.subarray(0, boundary).toString('utf8');
      this.readBuffer = this.readBuffer.subarray(boundary + 4);
      if (!/^HTTP\/1\.1 101\b/m.test(response)) {
        this.fail(new Error(`app-server proxy websocket upgrade failed: ${response.split('\r\n', 1)[0] ?? 'invalid response'}`));
        return;
      }
      const upgrade = this.upgrade;
      this.upgrade = undefined;
      upgrade.resolve();
    }
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (this.readBuffer.length >= 2) {
      const first = this.readBuffer[0]!;
      const second = this.readBuffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.readBuffer.length < offset + 2) return;
        length = this.readBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.readBuffer.length < offset + 8) return;
        const value = this.readBuffer.readBigUInt64BE(offset);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.fail(new Error('app-server proxy websocket frame is too large'));
          return;
        }
        length = Number(value);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.readBuffer.length < offset + length) return;
      const mask = masked ? this.readBuffer.subarray(maskOffset, maskOffset + 4) : undefined;
      let payload = this.readBuffer.subarray(offset, offset + length);
      this.readBuffer = this.readBuffer.subarray(offset + length);
      if (masked) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index++) payload[index]! ^= mask![index % 4]!;
      }
      this.handleFrame(opcode, fin, payload);
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.fail(new Error('app-server proxy websocket closed'));
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      if (!this.fragment) return;
      this.fragment.chunks.push(payload);
      if (!fin) return;
      const fragment = this.fragment;
      this.fragment = undefined;
      if (fragment.opcode === 0x1) this.onMessage(Buffer.concat(fragment.chunks).toString('utf8'));
      return;
    }
    if (!fin) {
      this.fragment = { opcode, chunks: [payload] };
      return;
    }
    if (opcode === 0x1) this.onMessage(payload.toString('utf8'));
  }

  private onMessage(line: string): void {
    let message: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJson(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (isJson(message.error)) pending.reject(new Error(stringValue(message.error.message) ?? 'app-server request failed'));
      else if (isJson(message.result)) pending.resolve(message.result);
      else pending.reject(new Error('app-server response has no result'));
      return;
    }
    const threadId = stringAt(message, 'params', 'threadId');
    if (!threadId) return;
    for (const callback of this.subscribers.get(threadId) ?? []) callback(message);
  }

  private fail(error: Error): void {
    const upgrade = this.upgrade;
    this.upgrade = undefined;
    upgrade?.reject(error);
    this.child = undefined;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const callbacks of this.subscribers.values()) {
      for (const callback of callbacks) callback({ method: 'turn/failed', params: { message: error.message } });
    }
  }

  private writeFrame(opcode: number, payload: Buffer, callback?: (error?: Error | null) => void): void {
    const child = this.child;
    if (!child) {
      callback?.(new Error('app-server proxy is unavailable'));
      return;
    }
    const mask = randomBytes(4);
    const length = payload.length;
    const header: number[] = [0x80 | opcode];
    if (length < 126) header.push(0x80 | length);
    else if (length <= 0xffff) header.push(0x80 | 126, (length >>> 8) & 0xff, length & 0xff);
    else {
      const encodedLength = Buffer.alloc(8);
      encodedLength.writeBigUInt64BE(BigInt(length));
      header.push(0x80 | 127, ...encodedLength);
    }
    const maskedPayload = Buffer.from(payload);
    for (let index = 0; index < maskedPayload.length; index++) maskedPayload[index]! ^= mask[index % 4]!;
    child.stdin.write(Buffer.concat([Buffer.from(header), mask, maskedPayload]), callback);
  }
}

class AppServerTurnTranslator {
  private pendingAgentMessage: string | undefined;
  private readonly agentDeltas = new Map<string, string>();

  translate(message: Json): AgentEvent[] {
    const method = stringValue(message.method);
    const params = jsonValue(message.params);
    if (!method || !params) return [];
    if (method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId);
      const delta = stringValue(params.delta);
      if (itemId && delta) this.agentDeltas.set(itemId, `${this.agentDeltas.get(itemId) ?? ''}${delta}`);
      return [];
    }
    if (method === 'item/started') {
      const item = jsonValue(params.item);
      if (item?.type !== 'commandExecution' && item?.type !== 'command_execution') return [];
      const id = stringValue(item.id);
      return id ? this.prependPendingText([{ type: 'tool_use', id, name: 'command_execution', input: { command: stringValue(item.command) ?? '' } }]) : [];
    }
    if (method === 'item/completed') return this.translateCompletedItem(params);
    if (method === 'turn/completed') return this.translateTurnCompleted(params);
    if (method === 'turn/failed' || method === 'error') {
      return this.prependPendingText([{ type: 'error', message: stringValue(params.message) ?? 'codex app-server turn failed', terminationReason: 'failed' }]);
    }
    return [];
  }

  private translateCompletedItem(params: Json): AgentEvent[] {
    const item = jsonValue(params.item);
    if (!item) return [];
    if (item.type === 'agentMessage' || item.type === 'agent_message') {
      const id = stringValue(item.id) ?? stringValue(params.itemId);
      const message = stringValue(item.text ?? item.message) ?? (id ? this.agentDeltas.get(id) : undefined);
      if (id) this.agentDeltas.delete(id);
      return message ? this.queueAgentMessage(message) : [];
    }
    if (item.type !== 'commandExecution' && item.type !== 'command_execution') return [];
    const id = stringValue(item.id);
    if (!id) return [];
    const exitCode = numberValue(item.exitCode ?? item.exit_code);
    return this.prependPendingText([{ type: 'tool_result', id, output: stringValue(item.aggregatedOutput ?? item.aggregated_output ?? item.output) ?? '', isError: exitCode !== undefined && exitCode !== 0 }]);
  }

  private translateTurnCompleted(params: Json): AgentEvent[] {
    const turn = jsonValue(params.turn);
    const status = stringValue(turn?.status);
    if (status === 'failed') return this.prependPendingText([{ type: 'error', message: stringValue(jsonValue(turn?.error)?.message) ?? 'codex app-server turn failed', terminationReason: 'failed' }]);
    const reason = status === 'interrupted' ? 'interrupted' : 'normal';
    const events: AgentEvent[] = [];
    if (this.pendingAgentMessage) events.push({ type: 'final_text', content: this.pendingAgentMessage });
    events.push({ type: 'done', threadId: stringValue(params.threadId), terminationReason: reason });
    return events;
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    if (message === this.pendingAgentMessage) return [];
    const events = this.pendingAgentMessage ? [{ type: 'text' as const, delta: this.pendingAgentMessage }] : [];
    this.pendingAgentMessage = message;
    return events;
  }

  private prependPendingText(events: AgentEvent[]): AgentEvent[] {
    if (!this.pendingAgentMessage) return events;
    const pending = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return [{ type: 'text', delta: pending }, ...events];
  }
}

class EventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = [];
  private waiting: ((result: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;
  private closeHandlers: Array<() => void> = [];

  push(value: AgentEvent): void {
    if (this.closed) return;
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: undefined, done: true }); }
  }
  onClose(handler: () => void): void { this.closed ? handler() : this.closeHandlers.push(handler); }
  async waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;
    return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); this.onClose(() => { clearTimeout(timer); resolve(true); }); });
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { this.waiting = resolve; });
    } };
  }
}

function threadIdFrom(value: Json): string | undefined {
  return stringAt(value, 'thread', 'id') ?? stringAt(value, 'id');
}
function stringAt(value: Json, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) { if (!isJson(current)) return undefined; current = current[key]; }
  return stringValue(current);
}
function jsonValue(value: unknown): Json | undefined { return isJson(value) ? value : undefined; }
function isJson(value: unknown): value is Json { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
