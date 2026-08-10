import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';

/**
 * RpcConnection — wraps a single `pi --mode rpc` child process.
 *
 * Protocol (verified against pi-coding-agent dist/modes/rpc/rpc-mode.js):
 * - stdin:  JSONL commands (prompt / steer / abort / switch_session / …)
 * - stdout: JSONL mixed stream:
 *   - `{type:"response", id, command, success, data?/error?}` — command ack
 *   - `{type:"extension_ui_request", id, method, …}` — extension UI dialog
 *   - AgentSessionEvent — same types as `--mode json`
 *
 * Lifecycle: process never exits on its own (pi blocks on
 * `return new Promise(() => {})`).  stdin EOF triggers graceful shutdown;
 * SIGKILL is the hard fallback.
 *
 * stdin writes are serialised through `writeQueue` — concurrent writes to
 * a pipe can interleave bytes and corrupt JSONL framing (rpc-mode.js
 * splits on `\n` only, via attachJsonlLineReader in jsonl.js).
 *
 * The `prompt` command is special: handleCommand returns `undefined` and
 * emits the success response asynchronously inside a `preflightResult`
 * callback.  All other commands return the response synchronously from
 * handleCommand.  Either way, `send()` correlates by id and resolves.
 */

type RpcChild = SpawnedProcessByStdio<WritableStdin, Readable, Readable>;

// node:child_process stdin is Writable at runtime; the union from
// SpawnedProcessByStdio widens to `null | Writable` so we narrow here.
type WritableStdin = import('node:stream').Writable & {
  write(chunk: string, cb: (err?: Error | null) => void): boolean;
  end(cb?: () => void): void;
  writable: boolean;
};

interface RpcResponse {
  id: string | undefined;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcConnectionOptions {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Default timeout for send() in ms. */
  defaultTimeoutMs?: number;
}

export class RpcConnection {
  private readonly child: RpcChild;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly defaultTimeoutMs: number;

  // Push-pull event queue (avoids polling).
  private readonly eventQueue: Record<string, unknown>[] = [];
  private eventWaiter: ((ev: Record<string, unknown> | null) => void) | null = null;

  // Serialised stdin writes — prevents JSONL line interleaving.
  private writeChain: Promise<void> = Promise.resolve();

  private _alive = true;
  private _sessionId: string | undefined;
  private _pid: number | undefined;
  private disposed = false;

  constructor(opts: RpcConnectionOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.child = spawnProcess(opts.binary, opts.args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as RpcChild; // stdin is Writable at runtime
    this._pid = this.child.pid ?? undefined;
    log.info('pi-rpc', 'spawn', {
      pid: this.child.pid ?? null,
      cwd: opts.cwd,
      args: opts.args.join(' '),
    });

    // stdout: strict LF-only JSONL reader (pi's jsonl.js deliberately
    // avoids readline because readline splits on extra Unicode separators).
    let stdoutBuf = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      while (true) {
        const nl = stdoutBuf.indexOf('\n');
        if (nl === -1) return;
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length > 0) this.handleLine(line);
      }
    });

    // stderr: log only.
    let stderrBuf = '';
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      while (true) {
        const nl = stderrBuf.indexOf('\n');
        if (nl === -1) return;
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) log.warn('pi-rpc', 'stderr', { line });
      }
    });

    this.child.on('exit', (code, signal) => {
      this._alive = false;
      log.info('pi-rpc', 'exit', { pid: this.child.pid ?? null, code, signal });
      this.onProcessDead(
        code === 0 ? `pi RPC exited (code=0)` : `pi RPC exited (code=${code}, signal=${signal})`,
      );
    });
    this.child.on('error', (err) => {
      this._alive = false;
      log.warn('pi-rpc', 'child-error', { err: err.message });
      this.onProcessDead(`pi RPC error: ${err.message}`);
    });
  }

  get alive(): boolean {
    return this._alive;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** Internal: called when the child process is gone (exit or error). */
  private onProcessDead(reason: string): void {
    // Reject all pending command requests.
    const err = new Error(reason);
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
    // Unblock the event consumer if it's waiting.
    if (this.eventWaiter) {
      const fn = this.eventWaiter;
      this.eventWaiter = null;
      fn(null);
    }
  }

  // ── stdout line demux ───────────────────────────────────────────

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('pi-rpc', 'parse-error', { line: line.slice(0, 200) });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return;

    switch (parsed.type) {
      case 'response':
        this.routeResponse(parsed as unknown as RpcResponse);
        return;
      case 'extension_ui_request':
        this.handleExtensionUIRequest(parsed);
        return;
      default:
        // AgentSessionEvent — same union as --mode json.
        // Capture sessionId from the session header for diagnostics.
        if (parsed.type === 'session') {
          const id = typeof (parsed.id ?? parsed.sessionId) === 'string'
            ? String(parsed.id ?? parsed.sessionId)
            : undefined;
          if (id) this._sessionId = id;
        }
        this.pushEvent(parsed);
        return;
    }
  }

  private routeResponse(res: RpcResponse): void {
    if (res.id === undefined) return;
    const req = this.pending.get(res.id);
    if (!req) return;
    this.pending.delete(res.id);
    clearTimeout(req.timer);
    if (res.success) {
      req.resolve(res.data);
    } else {
      req.reject(new Error(res.error ?? `pi RPC '${res.command}' failed`));
    }
  }

  /**
   * Auto-respond to extension UI requests.
   * Interactive methods (select/confirm/input/editor) get a cancellation;
   * fire-and-forget methods (notify/setTitle/setStatus/setWidget) are ignored.
   */
  private handleExtensionUIRequest(req: Record<string, unknown>): void {
    const id = req.id;
    const method = req.method;
    log.info('pi-rpc', 'extension-ui-request', { id, method });
    if (typeof id !== 'string') return;
    if (
      typeof method === 'string' &&
      ['select', 'confirm', 'input', 'editor'].includes(method)
    ) {
      void this.writeSerial(
        JSON.stringify({ type: 'extension_ui_response', id, cancelled: true }) + '\n',
      ).catch(() => {});
    }
  }

  // ── event queue ─────────────────────────────────────────────────

  private pushEvent(ev: Record<string, unknown>): void {
    if (this.eventWaiter) {
      const fn = this.eventWaiter;
      this.eventWaiter = null;
      fn(ev);
    } else {
      this.eventQueue.push(ev);
    }
  }

  /**
   * Consume AgentSessionEvents as an async generator. Yields events until
   * the process dies. The generator is single-consumer; calling it twice
   * is undefined behaviour.
   */
  async *events(): AsyncGenerator<Record<string, unknown>> {
    // Single-consumer guard: if a previous consumer's generator was
    // abandoned (for-await break without .return()), its stale waiter
    // would swallow new events. Clear it on entry.
    this.eventWaiter = null;
    try {
      while (true) {
        if (this.eventQueue.length > 0) {
          yield this.eventQueue.shift()!;
          continue;
        }
        if (!this._alive) return;
        const ev = await new Promise<Record<string, unknown> | null>((resolve) => {
          this.eventWaiter = resolve;
        });
        if (ev === null) return; // process died
        yield ev;
      }
    } finally {
      // Generator returned or was abandoned — clear the waiter so
      // pushEvent queues new events instead of sending them to a dead promise.
      this.eventWaiter = null;
    }
  }

  // ── stdin (serialised) ──────────────────────────────────────────

  private writeSerial(data: string): Promise<void> {
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const stdin = this.child.stdin;
          if (this.disposed || !stdin.writable) {
            reject(new Error('pi RPC stdin closed'));
            return;
          }
          stdin.write(data, (err) => (err ? reject(err) : resolve()));
        }),
    );
    return this.writeChain;
  }

  /**
   * Send a JSONL command and await its response. Every command gets a
   * unique `id`; the response is correlated back by `routeResponse`.
   *
   * NOTE: for the `prompt` command the response arrives asynchronously
   * (preflight callback), but the id correlation works the same way.
   */
  async send<T = unknown>(command: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this._alive) throw new Error('pi RPC process is dead');
    const id = randomUUID();
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const payload = JSON.stringify({ ...command, id }) + '\n';

    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi RPC '${command.type}' timed out (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
    });

    await this.writeSerial(payload);
    return result;
  }

  // ── convenience command wrappers ────────────────────────────────

  /** Send a prompt. Resolves when preflight succeeds (not when the turn ends). */
  async prompt(message: string, images?: readonly string[]): Promise<void> {
    await this.send({
      type: 'prompt',
      message,
      ...(images && images.length > 0 ? { images } : {}),
    });
  }

  /** Inject a steering message into the running turn. */
  async steer(message: string): Promise<void> {
    await this.send({ type: 'steer', message });
  }

  /** Gracefully abort the current turn (flushes partial output). */
  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  // ── lifecycle ───────────────────────────────────────────────────

  /**
   * Dispose: close stdin (triggers pi's graceful shutdown), wait for exit,
   * SIGKILL on timeout.
   */
  async dispose(timeoutMs = 5_000): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this._alive) return;

    const stdin = this.child.stdin;
    try {
      stdin.end();
    } catch {
      // already closed
    }

    await new Promise<void>((resolve) => {
      if (!this._alive) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (this._alive) {
          log.warn('pi-rpc', 'dispose-sigkill', { pid: this.child.pid ?? null });
          this.child.kill('SIGKILL');
        }
      }, timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Kill immediately (for error paths where graceful shutdown isn't viable). */
  kill(): void {
    if (this._alive) {
      this.child.kill('SIGKILL');
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
