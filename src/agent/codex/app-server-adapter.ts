import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import pkg from '../../../package.json';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import {
  CodexAppServerEventTranslator,
  CodexAppServerJsonRpc,
  type CodexAppServerIncoming,
} from './app-server-jsonrpc';
import {
  buildLeanAppServerArgs,
} from './app-server-lean';
import {
  buildAppServerProcessEnv,
  readAppServerConfigInventory,
  type CodexAppServerProcessOptions,
} from './app-server-process';

export interface CodexAppServerAdapterOptions extends CodexAppServerProcessOptions {
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  developerInstructions?: string;
}

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const RPC_TIMEOUT_MS = 15_000;
const NORMAL_SHUTDOWN_GRACE_MS = 250;
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_BUFFERED_NOTIFICATIONS = 2_000;

export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex App Server';

  private readonly options: CodexAppServerAdapterOptions;
  private botIdentity: AgentBotIdentity | undefined;
  private warnedExecOnlyConfig = false;
  private readonly preparedArgs = new Map<string, string[]>();

  constructor(options: CodexAppServerAdapterOptions) {
    this.options = options;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex App Server',
      command: this.options.binary,
      binaryPath: this.options.binary,
      args: ['app-server', '--help'],
    });
  }

  async prepareRun(options: AgentRunOptions): Promise<void> {
    if (!options.cwd) throw new Error('cwd is required for CodexAppServerAdapter.prepareRun');
    this.preparedArgs.delete(options.runId);
    try {
      const inventory = await readAppServerConfigInventory({
        binary: this.options.binary,
        cwd: options.cwd,
        env: buildAppServerProcessEnv(this.options),
      });
      this.preparedArgs.set(options.runId, buildLeanAppServerArgs(inventory));
    } catch (err) {
      throw new SpawnFailed(
        'codex app-server lean configuration probe failed',
        err,
        'agent-prepare-failed',
      );
    }
  }

  discardPreparedRun(options: AgentRunOptions): void {
    this.preparedArgs.delete(options.runId);
  }

  run(options: AgentRunOptions): AgentRun {
    const cwd = options.cwd;
    if (!cwd) throw new Error('cwd is required for CodexAppServerAdapter.run');
    const argv = this.preparedArgs.get(options.runId);
    if (!argv) {
      throw new Error('CodexAppServerAdapter.run requires prepareRun for the same runId');
    }
    this.preparedArgs.delete(options.runId);
    if (
      !this.warnedExecOnlyConfig &&
      (this.options.ignoreUserConfig || this.options.ignoreRules !== false)
    ) {
      this.warnedExecOnlyConfig = true;
      log.warn('app-server', 'exec-only-config-ignored', {
        ignoreUserConfig: this.options.ignoreUserConfig === true,
        ignoreRules: this.options.ignoreRules !== false,
      });
    }
    return new CodexAppServerRun({
      adapter: this.options,
      run: { ...options, cwd },
      botIdentity: this.botIdentity,
      argv,
    });
  }
}

interface CodexAppServerRunInput {
  adapter: CodexAppServerAdapterOptions;
  run: AgentRunOptions & { cwd: string };
  botIdentity?: AgentBotIdentity;
  argv: string[];
}

class CodexAppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;

  private readonly input: CodexAppServerRunInput;
  private readonly child: CodexAppServerChild;
  private readonly rpc: CodexAppServerJsonRpc;
  private readonly translator = new CodexAppServerEventTranslator();
  private readonly queue = new AsyncEventQueue();
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private readonly readline: ReadLineInterface;
  private readonly exitPromise: Promise<void>;
  private readonly terminalPromise: Promise<void>;
  private resolveTerminal!: () => void;
  private writeTail = Promise.resolve();
  private runtimeError: Error | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private stopRequested = false;
  private terminal = false;
  private exited = false;
  private normalShutdownTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingNotifications: Array<{ method: string; params: unknown }> = [];

  constructor(input: CodexAppServerRunInput) {
    this.input = input;
    this.runId = input.run.runId;
    this.events = this.queue;

    this.child = spawnProcess(
      input.adapter.binary,
      input.argv,
      {
        cwd: input.run.cwd,
        env: buildAppServerProcessEnv(input.adapter),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as CodexAppServerChild;

    this.rpc = new CodexAppServerJsonRpc((message) => this.writeMessage(message));
    this.terminalPromise = new Promise<void>((resolve) => {
      this.resolveTerminal = resolve;
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once('close', (code, signal) => {
        this.exited = true;
        if (this.normalShutdownTimer) clearTimeout(this.normalShutdownTimer);
        log.info('app-server', 'exit', { pid: this.child.pid ?? null, code, signal });
        const stderr = Buffer.concat(this.stderrChunks).toString('utf8').trim();
        const detail = this.runtimeError?.message ?? (stderr ? stderr.slice(0, 500) : undefined);
        this.rpc.fail(new Error(detail ?? `codex app-server exited: ${code ?? signal ?? 'unknown'}`));
        if (!this.terminal) {
          this.publish(
            this.translator.finish(
              this.stopRequested ? 'interrupted' : 'failed',
              this.stopRequested ? undefined : detail,
            ),
          );
        }
        this.readline.close();
        this.queue.close();
        resolve();
      });
    });

    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.installProcessHandlers();

    log.info('app-server', 'spawn', {
      pid: this.child.pid ?? null,
      cwd: input.run.cwd,
      hasThread: Boolean(input.run.threadId),
      lean: true,
      promptChars: input.run.prompt.length,
      images: input.run.images?.length ?? 0,
      model: input.run.model,
    });
    void this.start().catch((err) => this.failTransport(err));
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopRequested = true;
    const graceMs = this.input.run.stopGraceMs ?? this.input.adapter.stopGraceMs ?? 5000;

    if (!this.terminal && this.threadId && this.turnId) {
      try {
        await withTimeout(
          this.rpc.request('turn/interrupt', {
            threadId: this.threadId,
            turnId: this.turnId,
          }),
          Math.min(graceMs, 1000),
          'turn/interrupt',
        );
        await waitForPromise(this.terminalPromise, graceMs);
      } catch (err) {
        log.warn('app-server', 'interrupt-failed', {
          message: errorMessage(err),
          threadId: this.threadId,
          turnId: this.turnId,
        });
      }
    }

    if (!this.terminal) this.publish(this.translator.finish('interrupted'));
    this.terminate('SIGTERM');
    if (!(await waitForPromise(this.exitPromise, graceMs))) {
      log.warn('app-server', 'stop-sigkill', {
        pid: this.child.pid ?? null,
        graceMs,
        reason: 'grace-period-expired',
      });
      this.terminate('SIGKILL');
      await waitForPromise(this.exitPromise, 1000);
    }
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return waitForPromise(this.exitPromise, timeoutMs);
  }

  private installProcessHandlers(): void {
    this.child.once('error', (err) => {
      this.failTransport(err);
    });
    this.child.stdin.on('error', (err) => {
      if (this.exited || this.terminal) return;
      this.failTransport(err);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderrBytes < 64 * 1024) {
        this.stderrChunks.push(chunk);
        this.stderrBytes += chunk.byteLength;
      }
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) log.warn('app-server', 'stderr', { line });
      }
    });
    this.readline.on('line', (line) => this.receiveLine(line));
    this.readline.on('close', () => {
      if (!this.terminal && !this.exited) {
        this.failTransport(new Error('codex app-server stdout closed before a terminal event'));
      }
    });
  }

  private async start(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!this.child.pid) {
      throw new Error(
        this.runtimeError
          ? `failed to spawn codex app-server: ${this.runtimeError.message}`
          : 'failed to spawn codex app-server: spawn returned no pid',
      );
    }

    await withTimeout(
      this.rpc.request('initialize', {
        clientInfo: {
          name: 'lark-channel-bridge',
          title: 'Lark Channel Bridge',
          version: pkg.version,
        },
        capabilities: null,
      }),
      RPC_TIMEOUT_MS,
      'initialize',
    );
    await this.rpc.notify('initialized');
    if (this.stopRequested) throw new Error('codex app-server run stopped during initialization');

    const threadResult = await withTimeout(
      this.rpc.request(
        this.input.run.threadId ? 'thread/resume' : 'thread/start',
        this.threadParams(),
      ),
      RPC_TIMEOUT_MS,
      this.input.run.threadId ? 'thread/resume' : 'thread/start',
    );
    const threadResponse = recordValue(threadResult);
    const thread = recordValue(threadResponse?.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) throw new Error('codex app-server returned no thread id');
    if (this.input.run.threadId && threadId !== this.input.run.threadId) {
      throw new Error(`codex app-server resumed an unexpected thread: ${threadId}`);
    }
    this.threadId = threadId;
    if (!this.input.run.threadId) {
      await withTimeout(
        this.rpc.request('thread/name/set', {
          threadId,
          name: this.input.run.threadName?.trim() || '飞书 · 新会话',
        }),
        RPC_TIMEOUT_MS,
        'thread/name/set',
      );
    }
    this.publish([
      {
        type: 'system',
        threadId,
        cwd: stringValue(threadResponse?.cwd) ?? this.input.run.cwd,
        ...(stringValue(threadResponse?.model) ?? this.input.run.model
          ? { model: stringValue(threadResponse?.model) ?? this.input.run.model }
          : {}),
      },
    ]);

    const turnResult = await withTimeout(
      this.rpc.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: this.input.run.prompt },
          ...(this.input.run.images ?? []).map((path) => ({ type: 'localImage', path })),
        ],
        approvalPolicy: 'never',
        cwd: this.input.run.cwd,
        ...(this.input.run.model ? { model: this.input.run.model } : {}),
      }),
      RPC_TIMEOUT_MS,
      'turn/start',
    );
    const turnResponse = recordValue(turnResult);
    const turn = recordValue(turnResponse?.turn);
    const turnId = stringValue(turn?.id);
    if (!turnId) throw new Error('codex app-server returned no turn id');
    this.turnId = turnId;
    this.translator.setContext(threadId, turnId);
    this.flushPendingNotifications();
  }

  private threadParams(): Record<string, unknown> {
    const common = {
      cwd: this.input.run.cwd,
      approvalPolicy: 'never',
      sandbox: this.input.run.sandbox ?? this.input.adapter.sandbox ?? 'danger-full-access',
      developerInstructions:
        this.input.adapter.developerInstructions ?? buildBridgeSystemPrompt(this.input.botIdentity),
      ...(this.input.run.model ? { model: this.input.run.model } : {}),
    };
    return this.input.run.threadId
      ? { threadId: this.input.run.threadId, ...common }
      : {
          serviceName: 'lark-channel-bridge',
          threadSource: 'user',
          ephemeral: false,
          ...common,
        };
  }

  private receiveLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_PROTOCOL_LINE_CHARS) {
      this.failTransport(new Error('codex app-server emitted an oversized protocol line'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.failTransport(new Error('codex app-server emitted malformed JSON'));
      return;
    }
    let incoming: CodexAppServerIncoming | undefined;
    try {
      incoming = this.rpc.receive(parsed);
    } catch (err) {
      this.failTransport(err);
      return;
    }
    if (!incoming) return;
    if (incoming.kind === 'request') {
      void this.handleServerRequest(incoming).catch((err) => this.failTransport(err));
      return;
    }
    this.handleNotification(incoming.method, incoming.params);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!this.turnId && isRunNotification(method)) {
      if (this.pendingNotifications.length >= MAX_BUFFERED_NOTIFICATIONS) {
        this.failTransport(new Error('codex app-server notification buffer overflow'));
        return;
      }
      this.pendingNotifications.push({ method, params });
      return;
    }
    const events = this.translator.translate(method, params);
    this.publish(events);
    if (this.translator.terminalEmitted()) this.beginNormalShutdown();
  }

  private flushPendingNotifications(): void {
    for (const notification of this.pendingNotifications.splice(0)) {
      this.handleNotification(notification.method, notification.params);
      if (this.terminal) break;
    }
  }

  private async handleServerRequest(request: Extract<CodexAppServerIncoming, { kind: 'request' }>): Promise<void> {
    const decision = this.stopRequested ? 'cancel' : 'decline';
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        await this.rpc.respond(request.id, { decision });
        return;
      case 'item/tool/requestUserInput':
        await this.rpc.respond(request.id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        await this.rpc.respond(request.id, { action: decision });
        return;
      case 'item/permissions/requestApproval':
        await this.rpc.respond(request.id, { permissions: {}, scope: 'turn' });
        return;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        await this.rpc.respond(
          request.id,
          this.stopRequested
            ? { decision: 'abort' }
            : { decision: { denied: { rejection: 'lark-channel-bridge approval policy is never' } } },
        );
        return;
      default:
        log.warn('app-server', 'unsupported-server-request', { method: request.method });
        await this.rpc.respondError(request.id, -32601, `unsupported server request: ${request.method}`);
    }
  }

  private publish(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.queue.push(event);
      if (event.type === 'done' || event.type === 'error') {
        if (!this.terminal) {
          this.terminal = true;
          this.resolveTerminal();
          this.queue.close();
        }
      }
    }
  }

  private failTransport(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.runtimeError = err;
    this.rpc.fail(err);
    this.publish(this.translator.fail(`codex app-server protocol error: ${err.message}`));
    this.terminate('SIGTERM');
  }

  private beginNormalShutdown(): void {
    if (!this.terminal || this.exited) return;
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    if (this.normalShutdownTimer) return;
    this.normalShutdownTimer = setTimeout(() => this.terminate('SIGTERM'), NORMAL_SHUTDOWN_GRACE_MS);
  }

  private terminate(signal: NodeJS.Signals): void {
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill(signal);
  }

  private writeMessage(message: unknown): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const operation = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
            reject(new Error('codex app-server stdin is closed'));
            return;
          }
          try {
            this.child.stdin.write(line, 'utf8', (err?: Error | null) => {
              if (err) reject(err);
              else resolve();
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }),
    );
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<AgentEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`codex app-server ${operation} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRunNotification(method: string): boolean {
  return (
    method === 'error' ||
    method === 'thread/tokenUsage/updated' ||
    method.startsWith('turn/') ||
    method.startsWith('item/')
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
