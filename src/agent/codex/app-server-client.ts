import { createInterface, type Interface } from 'node:readline';
import pkg from '../../../package.json';
import type { AgentEvent, AgentRun } from '../types';
import { log } from '../../core/logger';
import {
  CodexAppServerJsonRpc,
  type CodexAppServerIncoming,
} from './app-server-jsonrpc';
import {
  buildAppServerProcessEnv,
  signalAppServerProcess,
  spawnCodexAppServer,
  terminateAndReapAppServer,
  type CodexAppServerChild,
  type CodexAppServerProcessOptions,
  type CodexAppServerSpawn,
  type TerminateAppServerOptions,
} from './app-server-process';
import {
  CodexAppServerEventTranslator,
  type AppServerFinishReason,
} from './app-server-translator';

export { CodexAppServerEventTranslator } from './app-server-translator';
export { CodexAppServerJsonRpc, CodexAppServerRpcError } from './app-server-jsonrpc';
export {
  APP_SERVER_PROCESS_GROUP_ENABLED,
  buildAppServerProcessEnv,
  signalAppServerProcess,
  spawnCodexAppServer,
  terminateAndReapAppServer,
} from './app-server-process';
export type {
  CodexAppServerChild,
  CodexAppServerProcessOptions,
  CodexAppServerSignal,
  CodexAppServerSpawn,
} from './app-server-process';

export interface CodexAppServerClientOptions extends CodexAppServerProcessOptions {
  clientName?: string;
  clientTitle?: string;
  timeoutMs?: number;
  stopGraceMs?: number;
}

export interface CodexAppServerRunOptions {
  runId: string;
  /** Pass the complete bridge-prefixed prompt. The client never rewrites it. */
  prompt: string;
  /** Alias for adapters that make the prefixing step explicit. */
  prefixedPrompt?: string;
  cwd?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  sandbox?: string;
  /** Optional per-turn developer instructions supplied by an adapter. */
  developerInstructions?: string;
  /** Structured context forwarded verbatim to the app-server turn/start call. */
  additionalContext?: Readonly<Record<string, CodexAppServerAdditionalContext>>;
  /** Internal app-server prime turns use an ephemeral thread. */
  ephemeral?: boolean;
  /** Kept for compatibility with adapters that use the AgentRun shape. */
  stopGraceMs?: number;
}

export interface CodexAppServerAdditionalContext {
  kind: 'untrusted' | 'application';
  value: string;
}

interface PendingNotification {
  readonly method: string;
  readonly params: unknown;
}

interface ProcessSession {
  readonly child: CodexAppServerChild;
  readonly rpc: CodexAppServerJsonRpc;
  readonly readline: Interface;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  readonly generation: number;
  alive: boolean;
  closing: boolean;
  reapPromise?: Promise<boolean>;
  primed: boolean;
  primePromise?: Promise<void>;
  readonly loadedThreads: Set<string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const TURN_START_TIMEOUT_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_BUFFERED_NOTIFICATIONS = 1_024;
const BACKGROUND_TERMINAL_CLEANUP_FAILURE =
  'codex app-server background terminal cleanup failed; generation retired';
const TURN_INTERRUPT_FAILURE =
  'codex app-server turn interruption failed; generation retired';
const PRIME_TIMEOUT_MS = 20_000;
const PRIME_PROMPT = 'Reply with READY. Do not call tools, MCP servers, or shell commands.';
const PRIME_FAILURE = 'codex app-server prime warmup failed; generation retired';
const STOP_GENERATION_RETIRED =
  'codex app-server turn start did not return before stop deadline; generation retired';

/**
 * One long-lived stdio app-server connection per client/profile. Every call
 * to startRun creates only a virtual turn; all virtual turns share the child
 * and its one initialize handshake.
 */
export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly timeoutMs: number;
  private readonly defaultStopGraceMs: number;
  private session: ProcessSession | undefined;
  private startPromise: Promise<ProcessSession> | undefined;
  private generation = 0;
  private shuttingDown = false;
  private readonly retiringReaps = new Set<Promise<boolean>>();
  private readonly activeRuns = new Set<CodexAppServerRun>();
  private readonly byThread = new Map<string, CodexAppServerRun>();
  private readonly byTurn = new Map<string, CodexAppServerRun>();
  private readonly retiredThreads = new Set<string>();
  private readonly retiredTurns = new Set<string>();
  /**
   * Thread-wide background-terminal cleanup is not scoped to a turn by the
   * app-server API. A follow-up on the same thread must therefore wait until
   * the previous cleanup has completed, otherwise it could terminate the new
   * turn's background process.
   */
  private readonly threadBarriers = new Map<string, Promise<void>>();
  private readonly pendingNotifications: PendingNotification[] = [];

  constructor(options: CodexAppServerClientOptions) {
    this.options = { ...options };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultStopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  /** Initialize the child once. No thread or turn is started by prepare(). */
  async prepare(): Promise<void> {
    await this.ensureSession();
  }

  async warmup(): Promise<void> {
    await this.prepare();
  }

  /**
   * Prime one app-server generation with a hidden, ephemeral read-only turn.
   * Concurrent callers share the same promise; a crashed generation is never
   * retried implicitly and the next explicit prime() call starts fresh.
   */
  async prime(cwd: string = this.options.cwd ?? '', developerInstructions?: string): Promise<void> {
    if (!cwd) throw new Error('cwd is required for CodexAppServerClient.prime');
    const session = await this.ensureSession();
    if (session.primed) return;
    if (session.primePromise) return session.primePromise;
    const promise = this.primeSession(session, cwd, developerInstructions);
    session.primePromise = promise;
    try {
      await promise;
    } finally {
      if (session.primePromise === promise) session.primePromise = undefined;
    }
  }

  /** Start one virtual turn on a shared app-server process. */
  startRun(options: CodexAppServerRunOptions): AgentRun {
    const cwd = options.cwd ?? this.options.cwd;
    if (!cwd) throw new Error('cwd is required for CodexAppServerClient.startRun');
    const run = new CodexAppServerRun(this, { ...options, cwd }, this.defaultStopGraceMs);
    this.activeRuns.add(run);
    void this.startRunOnServer(run);
    return run;
  }

  /** Alias matching AgentAdapter terminology. */
  run(options: CodexAppServerRunOptions): AgentRun {
    return this.startRun(options);
  }

  /** Stop the shared child and reject any active virtual turns. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of [...this.activeRuns]) run.failTransport(new Error('codex app-server client shut down'));
    const pendingStart = this.startPromise;
    const session = this.session;
    if (session) {
      session.closing = true;
      // If initialize is still pending, fail the JSON-RPC session first so
      // shutdown does not wait for its general 120s request timeout. The
      // shared reaper then closes the leader and its detached descendants.
      if (pendingStart && session.alive) {
        this.handleSessionFailure(
          session,
          new Error('codex app-server client shut down during startup'),
          { eofGraceMs: 0, terminateGraceMs: 100, killGraceMs: 100 },
        );
      }
      session.reapPromise ??= this.trackReap(terminateAndReapAppServer(session.child, session.closed, {
        eofGraceMs: 100,
        terminateGraceMs: this.defaultStopGraceMs,
        killGraceMs: 1_000,
      }));
      await session.reapPromise;
      if (this.session === session) this.session = undefined;
    }
    if (this.retiringReaps.size > 0) await Promise.all([...this.retiringReaps]);
    // createSession() observes the failed RPC and rejects startPromise. Attach
    // a handler without awaiting it so a late rejection cannot become an
    // unhandled promise while shutdown remains bounded by process teardown.
    if (pendingStart) void pendingStart.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  /** Number of currently live turns, useful for diagnostics/tests. */
  get activeTurnCount(): number {
    return this.activeRuns.size;
  }

  get trackedThreadCount(): number {
    return this.byThread.size;
  }

  get trackedTurnCount(): number {
    return this.byTurn.size;
  }

  /** Current process id, or undefined before lazy startup/after a crash. */
  get pid(): number | undefined {
    return this.session?.alive ? this.session.child.pid ?? undefined : undefined;
  }

  private async startRunOnServer(run: CodexAppServerRun, expectedSession?: ProcessSession): Promise<void> {
    let session: ProcessSession;
    try {
      session = expectedSession ?? await this.ensureSession();
      if (expectedSession && (!expectedSession.alive || this.session !== expectedSession)) {
        throw new Error('codex app-server prime generation is no longer alive');
      }
      if (!expectedSession && run.requestedThreadId) {
        await this._awaitThreadBarrier(run.requestedThreadId);
        // A failed cleanup retires its generation. Re-check the session after
        // the barrier so this follow-up cannot write to the dead child.
        if (!session.alive || this.session !== session) session = await this.ensureSession();
      }
      run.bindSession(session);
      if (run.stopRequested) {
        run.finish('interrupted');
        return;
      }

      let threadResponse: Record<string, unknown> | undefined;
      let threadId: string | undefined;
      if (run.requestedThreadId && session.loadedThreads.has(run.requestedThreadId)) {
        // A thread loaded in this app-server generation is already in memory;
        // issuing resume again is unnecessary and can race an active sibling.
        threadId = run.requestedThreadId;
        log.info('app-server', 'thread-loaded', {
          generation: session.generation,
          pid: session.child.pid ?? null,
          threadId,
        });
      } else {
        const threadResult = await this.request(session, run.threadMethod, run.threadParams());
        threadResponse = recordValue(threadResult);
        const thread = recordValue(threadResponse?.thread) ?? threadResponse;
        threadId = stringValue(thread?.id);
        if (!threadId) throw new Error('codex app-server returned no thread id');
        if (run.requestedThreadId && threadId !== run.requestedThreadId) {
          throw new Error(`codex app-server resumed an unexpected thread: ${threadId}`);
        }
        session.loadedThreads.add(threadId);
        log.info('app-server', run.threadMethod === 'thread/resume' ? 'thread-resumed' : 'thread-started', {
          generation: session.generation,
          method: run.threadMethod,
          pid: session.child.pid ?? null,
          threadId,
        });
      }
      run.bindThread(threadId, stringValue(threadResponse?.cwd) ?? run.cwd, stringValue(threadResponse?.model));
      this.bindThread(run, threadId);
      this.flushPendingNotifications();
      // The thread identity is durable evidence even if turn/start later
      // fails. Publish it before the next RPC so the session layer can retain
      // this thread for a safe resume instead of starting a new one.
      run.publishSystem();
      if (run.stopRequested) {
        run.finish('interrupted');
        return;
      }

      run.markTurnStartSent();
      const turnResult = await this.request(session, 'turn/start', run.turnParams(threadId));
      const turnResponse = recordValue(turnResult);
      const turn = recordValue(turnResponse?.turn) ?? turnResponse;
      const turnId = stringValue(turn?.id);
      if (!turnId) {
        const error = new Error('codex app-server returned no turn id');
        // The server may have accepted the turn even though its response was
        // malformed. Retire this generation so no unbound notifications or
        // real turn continue after the virtual run reports failure.
        this.handleSessionFailure(session, error);
        throw error;
      }
      run.bindTurn(turnId);
      this.bindTurn(run, turnId);
      log.info('app-server', 'turn-started', {
        generation: session.generation,
        pid: session.child.pid ?? null,
        runId: run.runId,
        threadId,
        turnId,
      });
      this.flushPendingNotifications();
      if (run.stopRequested) {
        // stop() may have raced the turn/start response. We now know the
        // server turn id, so ensure the actual turn receives an interrupt even
        // when the virtual run already emitted its local terminal event.
        await run.interruptTurn();
        if (!run.isTerminal) run.finish('interrupted');
        return;
      }
    } catch (error) {
      run.failProtocol(asError(error, 'codex app-server run failed'));
    }
  }

  private async primeSession(
    session: ProcessSession,
    cwd: string,
    developerInstructions?: string,
  ): Promise<void> {
    const noToolsInstructions = [
      developerInstructions?.trim(),
      'This is an internal warmup turn. Do not call tools, MCP servers, or shell commands.',
    ].filter(Boolean).join('\n\n');
    const run = new CodexAppServerRun(this, {
      runId: `__lark_channel_bridge_prime_${session.generation}`,
      prompt: PRIME_PROMPT,
      cwd,
      sandbox: 'read-only',
      developerInstructions: noToolsInstructions,
      ephemeral: true,
      stopGraceMs: this.defaultStopGraceMs,
    }, this.defaultStopGraceMs);
    this.activeRuns.add(run);
    void this.startRunOnServer(run, session);
    if (!(await run.waitForExit(PRIME_TIMEOUT_MS))) {
      this.handleSessionFailure(session, new Error(PRIME_FAILURE));
    }
    const events = await collectAgentRunEvents(run);
    const terminal = events.at(-1);
    if (!terminal || terminal.type === 'error') {
      if (session.alive) this.handleSessionFailure(session, new Error(PRIME_FAILURE));
      throw new Error(PRIME_FAILURE);
    }
    if (!session.alive) throw new Error(PRIME_FAILURE);
    session.primed = true;
  }

  private async ensureSession(): Promise<ProcessSession> {
    if (this.shuttingDown) throw new Error('codex app-server client is shut down');
    if (this.startPromise) return this.startPromise;
    // createSession publishes its ProcessSession before initialize resolves;
    // never hand that half-initialized state to a concurrent run.
    if (this.session?.alive && !this.session.closing) return this.session;

    // A crashed generation may still have descendants in its detached
    // process group. Do not spawn a replacement until that group's reaper has
    // completed, otherwise a stop caller could observe a new child while the
    // old turn is still executing.
    if (this.retiringReaps.size > 0) {
      await Promise.all([...this.retiringReaps]);
      if (this.shuttingDown) throw new Error('codex app-server client is shut down');
      if (this.startPromise) return this.startPromise;
      if (this.session?.alive && !this.session.closing) return this.session;
    }

    const start = this.createSession();
    this.startPromise = start;
    try {
      return await start;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  private async createSession(): Promise<ProcessSession> {
    const child = spawnCodexAppServer(this.options);
    const generation = ++this.generation;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    let writeTail = Promise.resolve();
    const writeMessage = (message: unknown): Promise<void> => {
      const line = `${JSON.stringify(message)}\n`;
      const operation = writeTail.then(() => new Promise<void>((resolve, reject) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          reject(new Error('codex app-server stdin is closed'));
          return;
        }
        try {
          child.stdin.write(line, 'utf8', (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      }));
      writeTail = operation.catch(() => undefined);
      return operation;
    };
    const rpc = new CodexAppServerJsonRpc(writeMessage);
    const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const state: ProcessSession = {
      child,
      rpc,
      readline,
      closed,
      resolveClosed,
      generation,
      alive: true,
      closing: false,
      primed: false,
      loadedThreads: new Set<string>(),
    };
    this.session = state;
    const stderrCategories = new Set<string>();
    let stderrBytes = 0;
    log.info('app-server', 'spawn', {
      generation,
      pid: child.pid ?? null,
    });

    const fail = (error: unknown): void => this.handleSessionFailure(state, asError(error, 'codex app-server connection closed'));
    child.once('error', fail);
    child.once('close', (code, signal) => {
      // Child stderr is not user-safe: MCP servers may print credentials,
      // request headers, or private URLs. Keep transport failures stable and
      // expose only the process termination status to AgentEvent consumers.
      log.info('app-server', 'exit', {
        code,
        signal,
        stderrBytes,
        stderrCategories: [...stderrCategories],
      });
      const status = code !== null && code !== undefined
        ? `code ${code}`
        : signal
          ? `signal ${signal}`
          : 'unknown status';
      fail(new Error(`codex app-server process exited (${status})`));
      state.resolveClosed();
    });
    child.stdin.on('error', fail);
    // Preserve useful failure categories without retaining raw MCP stderr,
    // which may contain credentials, request headers, or private URLs.
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      stderrCategories.add(classifyAppServerStderr(text));
    });
    readline.on('line', (line) => this.receiveLine(state, line));

    try {
      if (!child.pid) throw new Error('failed to spawn codex app-server');
      await this.request(state, 'initialize', {
        clientInfo: {
          name: this.options.clientName ?? 'lark-channel-bridge',
          title: this.options.clientTitle ?? 'Lark Channel Bridge',
          version: pkg.version,
        },
        capabilities: { experimentalApi: true },
      });
      await state.rpc.notify('initialized');
      if (!state.alive) throw new Error('codex app-server exited during initialize');
      log.info('app-server', 'ready', {
        generation,
        pid: child.pid ?? null,
      });
      return state;
    } catch (error) {
      this.handleSessionFailure(state, asError(error, 'codex app-server initialization failed'));
      throw error;
    }
  }

  private receiveLine(state: ProcessSession, line: string): void {
    if (!state.alive) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_PROTOCOL_LINE_CHARS) {
      this.handleSessionFailure(state, new Error('codex app-server emitted an oversized protocol line'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.handleSessionFailure(state, new Error('codex app-server emitted malformed JSON'));
      return;
    }
    let incoming: CodexAppServerIncoming | undefined;
    try {
      incoming = state.rpc.receive(parsed);
    } catch (error) {
      this.handleSessionFailure(state, asError(error, 'codex app-server protocol error'));
      return;
    }
    if (!incoming) return;
    if (incoming.kind === 'request') {
      void this.handleServerRequest(state, incoming).catch((error) => {
        this.handleSessionFailure(state, asError(error, 'codex app-server request handling failed'));
      });
      return;
    }
    this.routeNotification(incoming.method, incoming.params);
  }

  private routeNotification(method: string, params: unknown): void {
    if (this.isGlobalNoiseNotification(method)) return;
    const record = recordValue(params);
    const threadId = stringValue(record?.threadId);
    const turnId = stringValue(record?.turnId ?? recordValue(record?.turn)?.id);
    if (turnId && this.retiredTurns.has(turnId)) return;
    // A live turn id is authoritative even when an older run has just
    // retired the shared thread id. This matters when stop(A) overlaps the
    // immediate follow-up turn(B) on the same thread.
    const turnRun = turnId ? this.byTurn.get(turnId) : undefined;
    if (turnRun) {
      turnRun.acceptNotification(method, params);
      return;
    }
    if (threadId && this.retiredThreads.has(threadId)) return;
    const run = (threadId ? this.byThread.get(threadId) : undefined)
      ?? (!threadId && !turnId && this.activeRuns.size === 1
        ? [...this.activeRuns][0]
        : undefined);
    if (run) {
      run.acceptNotification(method, params);
      return;
    }
    // During thread/start and turn/start the response and notifications can
    // legally overtake one another. Keep a bounded queue until the id maps
    // exist; never guess between two active topics.
    if (this.isRunNotification(method) && this.pendingNotifications.length < MAX_BUFFERED_NOTIFICATIONS) {
      this.pendingNotifications.push({ method, params });
    } else if (this.isRunNotification(method)) {
      const session = this.session;
      const error = new Error('codex app-server notification buffer overflow');
      if (session?.alive) this.handleSessionFailure(session, error);
      else for (const activeRun of [...this.activeRuns]) activeRun.failProtocol(error);
    }
  }

  private flushPendingNotifications(): void {
    if (this.pendingNotifications.length === 0) return;
    const pending = this.pendingNotifications.splice(0);
    for (const notification of pending) this.routeNotification(notification.method, notification.params);
  }

  private async handleServerRequest(
    state: ProcessSession,
    request: Extract<CodexAppServerIncoming, { kind: 'request' }>,
  ): Promise<void> {
    const params = recordValue(request.params);
    const turnId = stringValue(params?.turnId ?? recordValue(params?.turn)?.id);
    const run = turnId ? this.byTurn.get(turnId) : undefined;
    const stopping = run?.stopRequested === true;
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        await state.rpc.respond(request.id, { decision: stopping ? 'cancel' : 'decline' });
        return;
      case 'item/tool/requestUserInput':
        await state.rpc.respond(request.id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        await state.rpc.respond(request.id, { action: stopping ? 'cancel' : 'decline', content: null });
        return;
      case 'item/permissions/requestApproval':
        await state.rpc.respond(request.id, { permissions: {}, scope: 'turn' });
        return;
      case 'currentTime/read':
        await state.rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        await state.rpc.respond(request.id, { decision: stopping ? 'abort' : 'denied' });
        return;
      default:
        await state.rpc.respondError(request.id, -32601, `unsupported server request: ${request.method}`);
    }
  }

  private async request(
    session: ProcessSession,
    method: string,
    params: unknown,
    timeoutMs = this.rpcTimeout(method),
  ): Promise<unknown> {
    try {
      return await withTimeout(this.requestRaw(session, method, params), timeoutMs, method);
    } catch (error) {
      // A timed-out request may already have reached the server. There is no
      // cancellation primitive in this stdio protocol, so retire the whole
      // generation to prevent an untracked turn continuing in the background.
      if (isRequestTimeout(error, method)) this.handleSessionFailure(session, asError(error, `codex app-server ${method} timed out`));
      throw error;
    }
  }

  private requestRaw(session: ProcessSession, method: string, params: unknown): Promise<unknown> {
    return session.rpc.request(method, params);
  }

  private rpcTimeout(method: string): number {
    if (this.options.timeoutMs !== undefined) return this.options.timeoutMs;
    if (method === 'turn/start') return TURN_START_TIMEOUT_MS;
    if (method === 'turn/interrupt') return INTERRUPT_TIMEOUT_MS;
    return this.timeoutMs;
  }

  private bindThread(run: CodexAppServerRun, threadId: string): void {
    if (run.isTerminal) {
      this.retiredThreads.add(threadId);
      return;
    }
    this.retiredThreads.delete(threadId);
    this.byThread.set(threadId, run);
  }

  private bindTurn(run: CodexAppServerRun, turnId: string): void {
    if (run.isTerminal) {
      this.retiredTurns.add(turnId);
      return;
    }
    this.retiredTurns.delete(turnId);
    this.byTurn.set(turnId, run);
  }

  _registerThreadBarrier(threadId: string, barrier: Promise<unknown>): void {
    // A failed cleanup already retires the generation. The next run should
    // wait for that reaper, then lazily start a replacement rather than fail
    // merely because the predecessor's cleanup rejected.
    const normalized = Promise.resolve(barrier).then(() => undefined, () => undefined);
    const prior = this.threadBarriers.get(threadId);
    const combined = prior
      ? Promise.all([prior, normalized]).then(() => undefined)
      : normalized;
    this.threadBarriers.set(threadId, combined);
    void combined.then(() => {
      if (this.threadBarriers.get(threadId) === combined) this.threadBarriers.delete(threadId);
    });
  }

  async _awaitThreadBarrier(threadId: string): Promise<void> {
    // Re-read after every await in case a second cleanup was registered while
    // the first barrier was settling.
    for (;;) {
      const barrier = this.threadBarriers.get(threadId);
      if (!barrier) return;
      await barrier;
      if (this.threadBarriers.get(threadId) === barrier) return;
    }
  }

  private onRunTerminal(run: CodexAppServerRun): void {
    this.activeRuns.delete(run);
    if (run.threadId) {
      const owner = this.byThread.get(run.threadId);
      if (owner === run) {
        this.byThread.delete(run.threadId);
        this.retiredThreads.add(run.threadId);
      } else if (owner) {
        // A newer follow-up run owns this thread; the old run must not retire
        // its shared thread routing key.
        this.retiredThreads.delete(run.threadId);
      } else {
        this.retiredThreads.add(run.threadId);
      }
    }
    if (run.turnId) {
      if (this.byTurn.get(run.turnId) === run) this.byTurn.delete(run.turnId);
      this.retiredTurns.add(run.turnId);
    }
    trimSet(this.retiredThreads);
    trimSet(this.retiredTurns);
  }

  private handleSessionFailure(
    state: ProcessSession,
    error: Error,
    reapOptions: TerminateAppServerOptions = {
      eofGraceMs: 0,
      terminateGraceMs: 1_000,
      killGraceMs: 1_000,
    },
  ): void {
    if (!state.alive) return;
    state.alive = false;
    state.closing = true;
    state.rpc.fail(error);
    state.readline.close();
    if (this.session === state) this.session = undefined;
    // Notifications buffered without ids belong to the crashed generation;
    // never replay them into a later app-server child.
    this.pendingNotifications.splice(0);
    for (const run of [...this.activeRuns]) {
      if (run.session === state) run.failTransport(error);
    }
    // Protocol/transport failure is not proof that the child stopped. Reap
    // it asynchronously so MCP descendants cannot outlive the bridge.
    state.reapPromise = this.trackReap(terminateAndReapAppServer(state.child, state.closed, reapOptions).catch(() => false));
  }

  private trackReap(reap: Promise<boolean>): Promise<boolean> {
    this.retiringReaps.add(reap);
    void reap.then(
      () => this.retiringReaps.delete(reap),
      () => this.retiringReaps.delete(reap),
    );
    return reap;
  }

  private isRunNotification(method: string): boolean {
    return method === 'error'
      || method === 'thread/tokenUsage/updated'
      || method.startsWith('turn/')
      || method.startsWith('item/');
  }

  private isGlobalNoiseNotification(method: string): boolean {
    return method.startsWith('mcpServer/')
      || method === 'skills/changed'
      || method === 'warning'
      || method.startsWith('warning/')
      || method.startsWith('account/')
      || method === 'thread/status/changed';
  }

  /** Internal hooks used by CodexAppServerRun without widening the public API. */
  _interrupt(run: CodexAppServerRun, threadId: string, turnId: string): Promise<unknown> {
    const session = run.session;
    if (!session || !session.alive) return Promise.reject(new Error('codex app-server process is not alive'));
    return this.request(
      session,
      'turn/interrupt',
      { threadId, turnId },
      Math.max(1, run.remainingStopGraceMs),
    ).catch(async (error: unknown) => {
      // A rejected interrupt is not confirmation that the server stopped the
      // turn. Retire this generation so the real turn cannot keep running
      // after the virtual run reports interruption.
      const safeError = new Error(TURN_INTERRUPT_FAILURE);
      this.handleSessionFailure(session, safeError);
      await session.reapPromise;
      throw safeError;
    });
  }

  async _retireForStop(run: CodexAppServerRun): Promise<void> {
    const session = run.session;
    if (!session || !session.alive) return;
    this.handleSessionFailure(session, new Error(STOP_GENERATION_RETIRED), {
      eofGraceMs: 0,
      terminateGraceMs: 100,
      killGraceMs: 100,
    });
    await session.reapPromise;
  }

  _cleanBackgroundTerminals(run: CodexAppServerRun, threadId: string): Promise<void> {
    const session = run.session;
    if (!session || !session.alive) return Promise.reject(new Error('codex app-server process is not alive'));
    // Cleanup is part of the run's stop/terminal deadline. Do not let the
    // general 120s RPC timeout keep stop() waiting while a background terminal
    // continues to execute. A timed-out cleanup retires the whole generation.
    return this.request(
      session,
      'thread/backgroundTerminals/clean',
      { threadId },
      Math.max(1, run.remainingStopGraceMs),
    )
      .then(() => undefined)
      .catch(async (error: unknown) => {
        // A rejected cleanup is not confirmation that background terminals
        // stopped. Retire/reap the generation instead of reporting a false
        // successful interruption to the caller.
        const safeError = new Error(BACKGROUND_TERMINAL_CLEANUP_FAILURE);
        this.handleSessionFailure(session, safeError);
        await session.reapPromise;
        throw safeError;
      });
  }

  _terminal(run: CodexAppServerRun): void {
    this.onRunTerminal(run);
  }

  _notificationBufferOverflow(run: CodexAppServerRun): void {
    const session = run.session;
    const error = new Error('codex app-server notification buffer overflow');
    if (session?.alive) this.handleSessionFailure(session, error);
    else run.failProtocol(error);
  }
}

/** Descriptive alias for adapters that call the shared client a controller. */
export class CodexAppServerRunController extends CodexAppServerClient {}

export function createCodexAppServerClient(options: CodexAppServerClientOptions): CodexAppServerClient {
  return new CodexAppServerClient(options);
}

/** A virtual AgentRun backed by one turn on the shared client process. */
export class CodexAppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly requestedThreadId: string | undefined;
  readonly cwd: string;
  readonly threadMethod: 'thread/start' | 'thread/resume';
  private readonly client: CodexAppServerClient;
  private readonly options: CodexAppServerRunOptions;
  private readonly queue = new AsyncEventQueue();
  private readonly terminalPromise: Promise<void>;
  private resolveTerminal!: () => void;
  private readonly stopGraceMs: number;
  private stopDeadline: number | undefined;
  private terminal = false;
  private systemPublished = false;
  private threadModel: string | undefined;
  private stopPromise: Promise<void> | undefined;
  private interruptPromise: Promise<void> | undefined;
  private sessionState: ProcessSession | undefined;
  private threadValue: string | undefined;
  private turnValue: string | undefined;
  private turnStartSent = false;
  private readonly earlyNotifications: PendingNotification[] = [];
  private readonly deferredNotifications: PendingNotification[] = [];
  private readonly translator = new CodexAppServerEventTranslator();
  private cleanupPending = false;
  private backgroundTerminalsCleaned = false;
  private cleanupFailure: Error | undefined;

  constructor(client: CodexAppServerClient, options: CodexAppServerRunOptions, defaultStopGraceMs: number) {
    this.client = client;
    this.options = options;
    this.runId = options.runId;
    this.cwd = options.cwd as string;
    this.requestedThreadId = options.threadId;
    this.threadMethod = options.threadId ? 'thread/resume' : 'thread/start';
    this.stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
    this.events = this.queue;
    this.terminalPromise = new Promise<void>((resolve) => { this.resolveTerminal = resolve; });
  }

  get threadId(): string | undefined { return this.threadValue; }
  get turnId(): string | undefined { return this.turnValue; }
  get turnStartWasSent(): boolean { return this.turnStartSent; }
  get stopRequested(): boolean { return this.stopPromise !== undefined; }
  get isTerminal(): boolean { return this.terminal; }
  get session(): ProcessSession | undefined { return this.sessionState; }
  get remainingStopGraceMs(): number {
    return this.stopDeadline === undefined
      ? this.stopGraceMs
      : Math.max(1, this.stopDeadline - Date.now());
  }

  bindSession(session: ProcessSession): void { this.sessionState = session; }

  threadParams(): Record<string, unknown> {
    const common: Record<string, unknown> = {
      cwd: this.cwd,
      approvalPolicy: 'never',
      ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
    };
    return this.options.threadId
      ? { threadId: this.options.threadId, ...common }
      : {
          serviceName: 'lark-channel-bridge',
          threadSource: 'user',
          ephemeral: this.options.ephemeral ?? false,
          ...(this.options.ephemeral ? { dynamicTools: [] } : {}),
          ...common,
        };
  }

  turnParams(threadId: string): Record<string, unknown> {
    return {
      threadId,
      input: [
        { type: 'text', text: this.options.prefixedPrompt ?? this.options.prompt },
        ...(this.options.images ?? []).map((path) => ({ type: 'localImage', path })),
      ],
      approvalPolicy: 'never',
      cwd: this.cwd,
      ...(this.options.sandbox ? { sandboxPolicy: sandboxPolicy(this.options.sandbox, this.cwd) } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.additionalContext ? { additionalContext: this.options.additionalContext } : {}),
      clientUserMessageId: this.runId,
    };
  }

  bindThread(threadId: string, cwd: string, model?: string): void {
    this.threadValue = threadId;
    this.threadModel = model;
    this.translator.setContext(threadId, 'pending-turn');
  }

  bindTurn(turnId: string): void {
    this.turnValue = turnId;
    if (this.threadValue) this.translator.setContext(this.threadValue, turnId);
    for (const notification of this.earlyNotifications.splice(0)) {
      this.acceptNotification(notification.method, notification.params);
    }
  }

  markTurnStartSent(): void {
    this.turnStartSent = true;
  }

  protocolDrift(): ReturnType<CodexAppServerEventTranslator['protocolDrift']> {
    return this.translator.protocolDrift();
  }

  publishSystem(): void {
    if (this.systemPublished || !this.threadValue) return;
    this.systemPublished = true;
    this.queue.push({
      type: 'system',
      threadId: this.threadValue,
      cwd: this.cwd,
      ...(this.threadModel || this.options.model ? { model: this.threadModel ?? this.options.model } : {}),
    });
  }

  acceptNotification(method: string, params: unknown): void {
    if (this.terminal) return;
    if (
      this.requestedThreadId &&
      method === 'thread/tokenUsage/updated' &&
      !stringValue(recordValue(params)?.turnId ?? recordValue(recordValue(params)?.turn)?.id)
    ) {
      // A resume may replay cumulative usage for the historical turn. It is
      // not safe to attribute that snapshot to the newly started virtual run.
      return;
    }
    if (this.cleanupPending) {
      if (this.deferredNotifications.length < MAX_BUFFERED_NOTIFICATIONS) {
        this.deferredNotifications.push({ method, params });
      } else {
        this.client._notificationBufferOverflow(this);
      }
      return;
    }
    if (!this.turnValue) {
      if (this.earlyNotifications.length < MAX_BUFFERED_NOTIFICATIONS) {
        this.earlyNotifications.push({ method, params });
      } else {
        this.client._notificationBufferOverflow(this);
      }
      return;
    }
    this.publishSystem();
    this.publishWithTerminalCleanup(this.translator.translate(method, params));
  }

  publish(events: readonly AgentEvent[]): void {
    if (this.terminal) return;
    for (const event of events) {
      this.queue.push(event);
      if (event.type === 'done' || event.type === 'error') {
        this.terminal = true;
        this.resolveTerminal();
        this.queue.close();
        this.client._terminal(this);
        return;
      }
    }
  }

  private publishWithTerminalCleanup(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    const terminalIndex = events.findIndex((event) => event.type === 'done' || event.type === 'error');
    if (terminalIndex < 0) {
      this.publish(events);
      return;
    }
    // Content/tool/usage events may be delivered immediately. The terminal
    // event itself is gated on cleanup so callers never observe a false done.
    this.publish(events.slice(0, terminalIndex));
    const terminalEvents = events.slice(terminalIndex);
    if (this.backgroundTerminalsCleaned || !this.threadValue || !this.sessionState?.alive) {
      this.publish(terminalEvents);
      return;
    }
    this.cleanupPending = true;
    const cleanup = this.client._cleanBackgroundTerminals(this, this.threadValue);
    this.client._registerThreadBarrier(this.threadValue, cleanup);
    void cleanup
      .then(() => {
        this.backgroundTerminalsCleaned = true;
        this.cleanupPending = false;
        this.deferredNotifications.splice(0);
        this.publish(terminalEvents);
      }, () => {
        this.cleanupPending = false;
        this.deferredNotifications.splice(0);
        this.publishCleanupFailure();
      });
  }

  private publishCleanupFailure(): void {
    if (this.terminal) return;
    this.publish([{
      type: 'error',
      message: BACKGROUND_TERMINAL_CLEANUP_FAILURE,
      terminationReason: 'failed',
    }]);
  }

  finish(reason: AppServerFinishReason): void {
    if (this.terminal) return;
    if (this.cleanupFailure) {
      this.publishCleanupFailure();
      return;
    }
    if (!this.turnValue) {
      this.publishSystem();
      this.publishWithTerminalCleanup([{
        type: 'done',
        threadId: this.threadValue,
        terminationReason: reason === 'interrupted' || reason === 'timeout' ? reason : 'interrupted',
      }]);
      return;
    }
    this.publishWithTerminalCleanup(this.translator.finish(reason));
  }

  failTransport(error: Error): void {
    if (this.terminal) return;
    const message = transportErrorMessage(error);
    const events = this.turnValue
      ? this.translator.fail(message)
      : [{ type: 'error' as const, message, terminationReason: 'failed' as const }];
    this.publish(events);
  }

  failProtocol(error: Error): void {
    if (this.terminal) return;
    const events = this.turnValue
      ? this.translator.fail(`codex app-server protocol error: ${error.message}`)
      : [{ type: 'error' as const, message: `codex app-server protocol error: ${error.message}`, terminationReason: 'failed' as const }];
    if (this.threadValue && this.sessionState?.alive) this.publishWithTerminalCleanup(events);
    else this.publish(events);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.terminal) return;
    this.stopDeadline = Date.now() + this.stopGraceMs;
    this.stopPromise = this.stopInternal();
    const barrierThreadId = this.threadValue ?? this.requestedThreadId;
    if (barrierThreadId) this.client._registerThreadBarrier(barrierThreadId, this.stopPromise);
    await this.stopPromise;
  }

  async interruptTurn(): Promise<void> {
    if (this.interruptPromise) return this.interruptPromise;
    const threadId = this.threadValue;
    const turnId = this.turnValue;
    if (!threadId || !turnId) return;
    this.cleanupPending = true;
    const interruptOperation = this.client._interrupt(this, threadId, turnId)
      .then(() => this.client._cleanBackgroundTerminals(this, threadId))
    this.client._registerThreadBarrier(threadId, interruptOperation);
    this.interruptPromise = interruptOperation
      .then(() => {
        this.backgroundTerminalsCleaned = true;
        this.cleanupPending = false;
        const deferred = this.deferredNotifications.splice(0);
        for (const notification of deferred) {
          this.acceptNotification(notification.method, notification.params);
        }
      }, (error: unknown) => {
        this.cleanupPending = false;
        this.deferredNotifications.splice(0);
        this.cleanupFailure = asError(error, 'codex app-server turn interruption/cleanup failed');
        // The generation has already been retired by _interrupt/_clean. Emit
        // a safe error now so callers cannot later observe a false done.
        this.publishCleanupFailure();
      })
      .then(() => undefined, () => undefined);
    await this.interruptPromise;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.terminal) return true;
    return waitFor(this.terminalPromise, timeoutMs);
  }

  private async stopInternal(): Promise<void> {
    await this.interruptTurn();
    if (!(await waitFor(this.terminalPromise, this.remainingStopGraceMs)) && !this.terminal) {
      if (this.turnStartWasSent && !this.turnValue) {
        // turn/start may already have been accepted even though its response
        // has not arrived. A local interrupted event would leave that real
        // turn running without an interruptable id, so retire/reap the whole
        // generation at the stop deadline.
        await this.client._retireForStop(this);
        if (!this.terminal) this.publishCleanupFailure();
        return;
      }
      this.finish('interrupted');
    }
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

async function collectAgentRunEvents(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`codex app-server ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(error === undefined ? fallback : String(error));
}

function isRequestTimeout(error: unknown, method: string): boolean {
  return error instanceof Error
    && error.message.startsWith(`codex app-server ${method} timed out after `);
}

function transportErrorMessage(error: Error): string {
  return error.message.startsWith('codex app-server process exited')
    ? error.message
    : `codex app-server process exited: ${error.message}`;
}

function sandboxPolicy(value: string, cwd: string): Record<string, unknown> {
  switch (value) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    default:
      return { type: value };
  }
}

function trimSet(values: Set<string>, max = 4096): void {
  while (values.size > max) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}

function classifyAppServerStderr(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('authentication')) return 'auth';
  if (lower.includes('429') || lower.includes('rate limit')) return 'rate-limit';
  if (lower.includes('tls') || lower.includes('eof') || lower.includes('502') || lower.includes('connection')) return 'network';
  if (lower.includes('config') || lower.includes('toml') || lower.includes('schema')) return 'config';
  if (lower.includes('mcp')) return 'mcp';
  return 'other';
}
