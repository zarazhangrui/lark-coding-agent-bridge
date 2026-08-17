import pkg from '../../../package.json';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import type {
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  AgentUserInputRequest,
} from '../types';
import {
  AppServerCompatibilityError,
  nonEmptyString,
  normalizeInitializeResult,
  normalizeThreadResult,
  normalizeTurnResult,
  normalizeUserInputRequest,
  recordValue,
  serializeUserInputResponse,
} from './app-server-normalizer';
import {
  AppServerTransport,
  JsonRpcRequestError,
  rpcId,
  rpcKey,
  type AppServerChild,
  type AppServerInboundHandler,
  type JsonRpcId,
} from './app-server-transport';
import { AppServerEventTranslator } from './app-server-translator';

export interface AppServerSessionOptions {
  run: Omit<AgentRunOptions, 'sandbox' | 'userInput'> & {
    sandbox: SandboxMode;
    userInput: Extract<AgentRunOptions['userInput'], { kind: 'interactive' }>;
  };
  botIdentity?: AgentBotIdentity;
  stopGraceMs: number;
}

interface PendingUserInput {
  controller: AbortController;
  toolId: string;
}

type DeferredTurnMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'user-input-request'; id: JsonRpcId; params: unknown };

type TurnState =
  | { kind: 'not-started' }
  | {
      kind: 'starting';
      messages: DeferredTurnMessage[];
      userInputRequestIds: Set<string>;
    }
  | { kind: 'active'; turnId: string };

type StartupStage = 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start';
type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

const HANDSHAKE_TIMEOUT_MS = 10_000;
const APP_SERVER_UPGRADE_MESSAGE =
  '当前 Codex CLI 不支持所需的 app-server 交互协议，请升级到 Codex CLI 0.107.0 或更高版本后重试。';

export class AppServerSession implements AppServerInboundHandler {
  private readonly queue = new AsyncEventQueue();
  private readonly pendingUserInput = new Map<string, PendingUserInput>();
  private readonly stderrChunks: Buffer[] = [];
  private readonly translator = new AppServerEventTranslator();
  private readonly transport: AppServerTransport;
  private threadId: string | undefined;
  private turnState: TurnState = { kind: 'not-started' };
  private terminal = false;
  private stopping = false;
  private startupStage: StartupStage = 'initialize';
  private readonly onRunAbort = (): void => {
    void this.stop();
  };

  constructor(
    private readonly child: AppServerChild,
    private readonly options: AppServerSessionOptions,
  ) {
    this.transport = new AppServerTransport(child, this, HANDSHAKE_TIMEOUT_MS);
    this.attachProcessListeners();
    const runSignal = this.options.run.userInput.signal;
    runSignal.addEventListener('abort', this.onRunAbort, { once: true });
    if (runSignal.aborted) this.onRunAbort();
  }

  agentRun(): AgentRun {
    return {
      runId: this.options.run.runId,
      events: this.events(),
      stop: () => this.stop(),
      waitForExit: (timeoutMs) => waitForExit(this.child, timeoutMs),
    };
  }

  onNotification(method: string, paramsInput: unknown): void {
    if (this.terminal) return;
    if (this.turnState.kind === 'starting' && isTurnScopedNotification(method)) {
      this.turnState.messages.push({ kind: 'notification', method, params: paramsInput });
      return;
    }
    this.dispatchNotification(method, paramsInput);
  }

  private dispatchNotification(method: string, paramsInput: unknown): void {
    if (this.terminal) return;
    const params = recordValue(paramsInput);
    switch (method) {
      case 'thread/started':
      case 'turn/started':
      case 'thread/status/changed':
        return;
      case 'item/agentMessage/delta': {
        const valid = this.validateDeltaNotification(method, paramsInput);
        if (valid) this.pushAll(this.translator.agentMessageDelta(valid));
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const valid = this.validateReasoningDelta(method, paramsInput);
        if (valid) this.pushAll(this.translator.reasoningDelta(valid));
        return;
      }
      case 'item/started': {
        const item = this.validateItemNotification(method, paramsInput);
        if (item) this.pushAll(this.translator.itemStarted(item));
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const valid = this.validateDeltaNotification(method, paramsInput);
        if (valid) this.translator.commandOutputDelta(valid);
        return;
      }
      case 'item/completed': {
        const item = this.validateItemNotification(method, paramsInput);
        if (item) this.pushAll(this.translator.itemCompleted(item));
        return;
      }
      case 'thread/tokenUsage/updated': {
        const valid = this.validateUsageNotification(paramsInput);
        if (valid) this.pushAll(this.translator.usageUpdated(valid));
        return;
      }
      case 'serverRequest/resolved':
        this.serverRequestResolved(paramsInput);
        return;
      case 'error': {
        const valid = this.validateTurnParams(method, paramsInput);
        const error = recordValue(valid?.error);
        const message = nonEmptyString(error?.message);
        if (!valid || !message || typeof valid.willRetry !== 'boolean') {
          if (valid) this.fail('Codex error 通知字段不合法');
          return;
        }
        if (!valid.willRetry) this.fail(message);
        return;
      }
      case 'turn/completed':
        this.turnCompleted(paramsInput);
        return;
      default:
        // Unknown methods are protocol noise by design (observed: warning,
        // remoteControl/status/changed, thread/goal/cleared,
        // account/rateLimits/updated). Log structural metadata only —
        // arbitrary payloads may carry user content or credentials, and a
        // truncated JSON string could even defeat downstream redaction.
        log.info('app-server', 'notification-ignored', {
          method,
          paramsKeys: params ? Object.keys(params).slice(0, 16) : [],
          paramsBytes: Buffer.byteLength(JSON.stringify(paramsInput ?? null), 'utf8'),
        });
    }
  }

  private validateTurnParams(
    method: string,
    paramsInput: unknown,
  ): Record<string, unknown> | undefined {
    const params = recordValue(paramsInput);
    const requestThreadId = nonEmptyString(params?.threadId);
    const requestTurnId = nonEmptyString(params?.turnId);
    if (
      !requestThreadId
      || !requestTurnId
      || requestThreadId !== this.threadId
      || this.turnState.kind !== 'active'
      || requestTurnId !== this.turnState.turnId
    ) {
      this.fail(`Codex ${method} 通知的 thread/turn 上下文不合法`);
      return undefined;
    }
    return params;
  }

  private validateDeltaNotification(
    method: string,
    paramsInput: unknown,
  ): Record<string, unknown> | undefined {
    const params = this.validateTurnParams(method, paramsInput);
    if (!params) return undefined;
    if (!nonEmptyString(params.itemId) || typeof params.delta !== 'string') {
      this.fail(`Codex ${method} 通知字段不合法`);
      return undefined;
    }
    return params;
  }

  private validateReasoningDelta(
    method: string,
    paramsInput: unknown,
  ): Record<string, unknown> | undefined {
    const params = this.validateDeltaNotification(method, paramsInput);
    if (!params) return undefined;
    const indexKey = method === 'item/reasoning/summaryTextDelta'
      ? 'summaryIndex'
      : 'contentIndex';
    if (!isInteger(params[indexKey])) {
      this.fail(`Codex ${method} 通知字段不合法`);
      return undefined;
    }
    return params;
  }

  private validateItemNotification(
    method: string,
    paramsInput: unknown,
  ): Record<string, unknown> | undefined {
    const params = this.validateTurnParams(method, paramsInput);
    if (!params) return undefined;
    const item = recordValue(params.item);
    const type = nonEmptyString(item?.type);
    const id = nonEmptyString(item?.id);
    if (!item || !type || !id) {
      this.fail(`Codex ${method} 通知的 item 字段不合法`);
      return undefined;
    }
    if (type === 'agentMessage') {
      if (typeof item.text !== 'string') {
        this.fail(`Codex ${method} agentMessage 字段不合法`);
        return undefined;
      }
      return item;
    }
    if (type === 'commandExecution') {
      if (
        !nonEmptyString(item.command)
        || !Array.isArray(item.commandActions)
        || !nonEmptyString(item.cwd)
        || !isCommandStatus(item.status)
      ) {
        this.fail(`Codex ${method} commandExecution 字段不合法`);
        return undefined;
      }
      return item;
    }
    // Later protocol versions may add item variants. The envelope and common
    // identity are still validated, while unknown variants remain ignorable.
    return item;
  }

  private validateUsageNotification(
    paramsInput: unknown,
  ): Record<string, unknown> | undefined {
    const params = recordValue(paramsInput);
    const requestThreadId = nonEmptyString(params?.threadId);
    const requestTurnId = nonEmptyString(params?.turnId);
    if (!params || !requestThreadId || !requestTurnId) {
      log.warn('app-server', 'token-usage-ignored', { reason: 'invalid-context' });
      return undefined;
    }

    // Resuming a thread can replay the previous turn's latest usage both
    // before thread/resume settles and while the next turn/start is in
    // flight. Usage is optional telemetry, so those startup/late snapshots
    // must not terminate the new turn. Notifications for the turn being
    // started are buffered by onNotification() and reach this branch only
    // after the active turn id is known.
    if (this.turnState.kind !== 'active' || !this.threadId) {
      log.info('app-server', 'token-usage-ignored', { reason: 'turn-not-active' });
      return undefined;
    }
    if (requestThreadId !== this.threadId) {
      log.info('app-server', 'token-usage-ignored', { reason: 'other-thread' });
      return undefined;
    }
    if (requestTurnId !== this.turnState.turnId) {
      log.info('app-server', 'token-usage-ignored', { reason: 'stale-turn' });
      return undefined;
    }

    const tokenUsage = recordValue(params.tokenUsage);
    const last = recordValue(tokenUsage?.last);
    const total = recordValue(tokenUsage?.total);
    if (
      !tokenUsage
      || !last
      || !total
      || !isUsageBreakdown(last)
      || !isUsageBreakdown(total)
    ) {
      log.warn('app-server', 'token-usage-ignored', { reason: 'invalid-fields' });
      return undefined;
    }
    return params;
  }

  onRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.terminal) return;
    if (method === 'item/tool/requestUserInput') {
      if (this.turnState.kind === 'starting') {
        const key = rpcKey(id);
        if (this.turnState.userInputRequestIds.has(key)) {
          this.fail('Codex 重复使用了同一个用户输入 request id');
          return;
        }
        this.turnState.userInputRequestIds.add(key);
        this.turnState.messages.push({ kind: 'user-input-request', id, params });
        return;
      }
      if (this.turnState.kind === 'active') {
        void this.handleUserInputRequest(id, params, this.turnState.turnId);
        return;
      }
      this.fail('Codex 用户输入请求出现在 turn 建立之前');
      return;
    }
    void this.transport.respondError(id, -32601, `Method not found: ${method}`).catch((err) => {
      this.fail(`回复不支持的 Codex app-server 请求失败：${errorMessage(err)}`);
    });
  }

  onMalformed(message: string): void {
    this.fail(message);
  }

  private async *events(): AsyncGenerator<AgentEvent> {
    if (!this.child.pid) {
      this.settle({
        type: 'error',
        message: 'Codex app-server 进程启动失败',
        terminationReason: 'failed',
      });
    } else {
      void this.start().catch((err) => this.startupFailed(err));
    }
    for await (const event of this.queue) yield event;
  }

  private async start(): Promise<void> {
    this.startupStage = 'initialize';
    const initializeResult = await this.transport.request('initialize', {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: pkg.version,
      },
      capabilities: { experimentalApi: true },
    });
    normalizeInitializeResult(initializeResult);
    if (this.stopping || this.terminal) return;
    await this.transport.notify('initialized');

    const run = this.options.run;
    this.startupStage = run.threadId ? 'thread/resume' : 'thread/start';
    const threadResult = run.threadId
      ? await this.transport.request('thread/resume', {
          threadId: run.threadId,
          ...threadSettings(run),
        })
      : await this.transport.request('thread/start', threadSettings(run));
    const { threadId } = normalizeThreadResult(threadResult);
    if (this.stopping || this.terminal) return;
    this.threadId = threadId;
    this.queue.push({
      type: 'system',
      threadId,
      cwd: run.cwd,
      ...(run.model ? { model: run.model } : {}),
    });

    const input: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: prefixBridgeSystemPrompt(run.prompt, this.options.botIdentity),
        text_elements: [],
      },
      ...(run.images ?? []).map((path) => ({ type: 'localImage', path })),
    ];
    this.startupStage = 'turn/start';
    this.turnState = { kind: 'starting', messages: [], userInputRequestIds: new Set() };
    const turnResult = await this.transport.request('turn/start', { threadId, input });
    const { turnId } = normalizeTurnResult(turnResult);
    if (this.stopping || this.terminal) return;
    const deferredMessages = this.turnState.kind === 'starting'
      ? [...this.turnState.messages]
      : [];
    this.turnState = { kind: 'active', turnId };
    for (const message of deferredMessages) {
      if (this.stopping || this.terminal) break;
      if (message.kind === 'notification') {
        this.dispatchNotification(message.method, message.params);
      } else {
        void this.handleUserInputRequest(message.id, message.params, turnId);
      }
    }

    log.info('agent', 'app-server-ready', {
      pid: this.child.pid,
      cwd: run.cwd,
      hasThread: Boolean(run.threadId),
      threadId,
      turnId,
      images: run.images?.length ?? 0,
      model: run.model,
    });
  }

  private startupFailed(error: unknown): void {
    if (this.terminal) return;
    if (this.stopping) {
      this.settleInterrupted();
      return;
    }
    if (
      error instanceof AppServerCompatibilityError
      || (error instanceof JsonRpcRequestError && error.method === 'initialize' && error.code === -32601)
    ) {
      this.fail(`${APP_SERVER_UPGRADE_MESSAGE}（${errorMessage(error)}）`);
      return;
    }
    this.fail(`Codex app-server 在 ${this.startupStage} 阶段失败：${errorMessage(error)}`);
  }

  private attachProcessListeners(): void {
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
      const text = chunk.toString('utf8').trim();
      if (text) log.warn('agent', 'stderr', { line: text.slice(0, 1000) });
    });
    this.child.once('error', (err) => this.processFailed(err));
    this.child.stdin.on('error', (err) => this.processFailed(err));
    this.child.once('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: this.child.pid ?? null, code, signal });
      this.abortUserInput('Codex app-server 已退出');
      this.transport.rejectPending(new Error(`app-server 已退出：${code ?? signal ?? 'unknown'}`));
      if (this.terminal) return;
      if (this.stopping) {
        this.settleInterrupted();
        return;
      }
      const stderr = Buffer.concat(this.stderrChunks).toString('utf8').trim();
      this.fail(`Codex app-server 异常退出${stderr ? `：${stderr.slice(0, 500)}` : ''}`);
    });
  }

  private processFailed(error: Error): void {
    this.transport.rejectPending(error);
    if (this.terminal) return;
    if (this.stopping) {
      this.settleInterrupted();
      return;
    }
    this.fail(`Codex app-server 进程错误：${error.message}`);
  }

  private serverRequestResolved(paramsInput: unknown): void {
    const params = recordValue(paramsInput);
    const requestThreadId = nonEmptyString(params?.threadId);
    const requestId = rpcId(params?.requestId);
    if (!requestThreadId || requestThreadId !== this.threadId || requestId === undefined) {
      this.fail('serverRequest/resolved 的 thread/request 上下文不合法');
      return;
    }
    this.resolveUserInputRequest(requestId);
  }

  private resolveUserInputRequest(requestId: JsonRpcId): void {
    const key = rpcKey(requestId);
    const pending = this.pendingUserInput.get(key);
    if (!pending) return;
    this.pendingUserInput.delete(key);
    pending.controller.abort(new Error('Codex 已结束此输入请求'));
    this.queue.push({
      type: 'tool_result',
      id: pending.toolId,
      output: 'Codex 已结束此输入请求',
      isError: false,
    });
  }

  private turnCompleted(paramsInput: unknown): void {
    const params = recordValue(paramsInput);
    const turn = recordValue(params?.turn);
    const requestThreadId = nonEmptyString(params?.threadId);
    const requestTurnId = nonEmptyString(turn?.id);
    const status = nonEmptyString(turn?.status);
    if (
      !requestThreadId
      || !requestTurnId
      || !status
      || requestThreadId !== this.threadId
      || this.turnState.kind !== 'active'
      || requestTurnId !== this.turnState.turnId
    ) {
      this.fail('turn/completed 的 thread/turn 上下文不合法');
      return;
    }
    this.abortUserInput('Codex turn 已结束');
    if (this.stopping) {
      this.settleInterrupted();
      return;
    }
    if (status === 'failed') {
      const error = recordValue(turn?.error);
      this.fail(nonEmptyString(error?.message) ?? 'Codex turn 执行失败');
      return;
    }
    if (status === 'interrupted') {
      this.settleInterrupted();
      return;
    }
    if (status !== 'completed') {
      this.fail(`turn/completed 返回了未知状态：${status}`);
      return;
    }
    const finalMessage = this.translator.takeFinalMessage();
    if (finalMessage) this.queue.push({ type: 'final_text', content: finalMessage });
    this.settle({ type: 'done', threadId: this.threadId, terminationReason: 'normal' });
  }

  private async handleUserInputRequest(
    id: JsonRpcId,
    paramsInput: unknown,
    expectedTurnId: string,
  ): Promise<void> {
    const params = recordValue(paramsInput);
    const requestThreadId = nonEmptyString(params?.threadId);
    const requestTurnId = nonEmptyString(params?.turnId);
    if (
      !requestThreadId
      || !requestTurnId
      || requestThreadId !== this.threadId
      || requestTurnId !== expectedTurnId
    ) {
      this.fail('Codex 用户输入请求的 thread/turn 上下文不合法');
      return;
    }

    let request: AgentUserInputRequest;
    try {
      request = normalizeUserInputRequest(paramsInput);
    } catch (err) {
      this.fail(`Codex 用户输入请求不合法：${errorMessage(err)}`);
      return;
    }
    const runSignal = this.options.run.userInput.signal;
    if (runSignal.aborted || this.stopping || this.terminal) return;

    const key = rpcKey(id);
    if (this.pendingUserInput.has(key)) {
      this.fail('Codex 重复使用了同一个用户输入 request id');
      return;
    }
    if ([...this.pendingUserInput.values()].some((pending) => pending.toolId === request.id)) {
      this.fail(`Codex 重复使用了用户输入 itemId：${request.id}`);
      return;
    }

    const controller = new AbortController();
    const abortFromRun = (): void => controller.abort(runSignal.reason);
    runSignal.addEventListener('abort', abortFromRun, { once: true });
    if (runSignal.aborted) {
      runSignal.removeEventListener('abort', abortFromRun);
      return;
    }
    this.pendingUserInput.set(key, { controller, toolId: request.id });
    this.queue.push({
      type: 'tool_use',
      id: request.id,
      name: 'request_user_input',
      input: request,
    });

    try {
      const response = await this.options.run.userInput.handle(request, controller.signal);
      if (!this.pendingUserInput.has(key)) return;
      const answers = serializeUserInputResponse(request, response);
      this.pendingUserInput.delete(key);
      await this.transport.respond(id, { answers });
      this.queue.push({
        type: 'tool_result',
        id: request.id,
        output: '用户已提交回答',
        isError: false,
      });
    } catch (err) {
      if (controller.signal.aborted || this.stopping || this.terminal) return;
      this.pendingUserInput.delete(key);
      this.fail(`处理 Codex 用户输入请求失败：${errorMessage(err)}`);
    } finally {
      runSignal.removeEventListener('abort', abortFromRun);
    }
  }

  private pushAll(events: readonly AgentEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  private abortUserInput(reason: string): void {
    for (const pending of this.pendingUserInput.values()) {
      pending.controller.abort(new Error(reason));
    }
    this.pendingUserInput.clear();
    if (this.turnState.kind === 'starting') {
      this.turnState.messages.splice(0);
      this.turnState.userInputRequestIds.clear();
    }
  }

  private fail(message: string): void {
    this.settle({
      type: 'error',
      message: message.slice(0, 4096),
      terminationReason: 'failed',
    });
  }

  private settleInterrupted(): void {
    this.settle({
      type: 'done',
      threadId: this.threadId,
      terminationReason: 'interrupted',
    });
  }

  private settle(event: TerminalEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.options.run.userInput.signal.removeEventListener('abort', this.onRunAbort);
    this.abortUserInput(event.type === 'error' ? event.message : '运行已结束');
    this.transport.rejectPending(new Error(event.type === 'error' ? event.message : '运行已结束'));
    this.queue.push(event);
    this.queue.close();
    void this.terminateProcess();
  }

  private async stop(): Promise<void> {
    if (this.stopping || this.terminal) return;
    this.stopping = true;
    this.abortUserInput('运行已停止');
    this.transport.rejectPending(new Error('运行已停止'));
    if (this.threadId && this.turnState.kind === 'active') {
      await this.transport.sendRequest('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnState.turnId,
      }).catch(() => {});
    }
    await this.terminateProcess();
    if (!this.terminal) this.settleInterrupted();
  }

  private async terminateProcess(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    const exited = await waitForExit(this.child, this.options.stopGraceMs);
    if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }
}

function threadSettings(run: AppServerSessionOptions['run']): Record<string, unknown> {
  return {
    cwd: run.cwd,
    approvalPolicy: 'never',
    sandbox: run.sandbox,
    ...(run.model ? { model: run.model } : {}),
  };
}

const TURN_SCOPED_NOTIFICATIONS = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/started',
  'item/commandExecution/outputDelta',
  'item/completed',
  'thread/tokenUsage/updated',
  'serverRequest/resolved',
  'error',
  'turn/completed',
]);

function isTurnScopedNotification(method: string): boolean {
  return TURN_SCOPED_NOTIFICATIONS.has(method);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isCommandStatus(value: unknown): boolean {
  return value === 'inProgress'
    || value === 'completed'
    || value === 'failed'
    || value === 'declined';
}

function isUsageBreakdown(value: Record<string, unknown>): boolean {
  return isInteger(value.inputTokens)
    && isInteger(value.outputTokens)
    && isInteger(value.cachedInputTokens)
    && isInteger(value.reasoningOutputTokens)
    && isInteger(value.totalTokens);
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly events: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.events.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    while (true) {
      const event = this.events.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

function waitForExit(child: AppServerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
