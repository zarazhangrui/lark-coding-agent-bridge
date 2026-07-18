import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';

/**
 * Minimal NDJSON-over-stdio JSON-RPC 2.0 client for the Agent Client
 * Protocol (ACP). Handles request/response correlation, notifications,
 * and bidirectional messaging over a child process's stdin/stdout.
 *
 * @see https://agentclientprotocol.com/protocol/v1/overview
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AcpClientEvents {
  notification: [JsonRpcNotification];
  request: [JsonRpcRequest]; // Agent → Client requests (e.g. request_permission)
  closed: [];
  error: [Error];
}

/**
 * ACP client that speaks JSON-RPC 2.0 over NDJSON (newline-delimited JSON)
 * on a child process's stdin/stdout.
 *
 * - `call()` sends a request and awaits the response.
 * - `notify()` sends a notification (no response expected).
 * - `on('notification', ...)` receives Agent → Client notifications
 *   (e.g. `session/update`).
 * - `on('request', ...)` receives Agent → Client requests
 *   (e.g. `session/request_permission`). The handler MUST call
 *   `respond(id, result)` or `respondError(id, code, message)` to reply.
 */
export class AcpClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    private readonly child: ChildProcess,
  ) {
    super();
    this.startReading();
    this.wireLifecycle();
  }

  private startReading(): void {
    const rl = createInterface({ input: this.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        log.warn('acp', 'parse-error', { line: line.slice(0, 200), err: String(err) });
        return;
      }
      this.handleMessage(msg);
    });
    rl.on('close', () => this.handleClose());
  }

  private wireLifecycle(): void {
    this.child.on('exit', (code, signal) => {
      log.info('acp', 'child-exit', { pid: this.child.pid ?? null, code, signal });
      this.handleClose();
    });
    this.child.on('error', (err) => {
      this.emit('error', err);
      this.handleClose();
    });
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests
    if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      const resp = msg as JsonRpcResponse;
      if (resp.error) {
        pending.reject(
          new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`),
        );
      } else {
        pending.resolve(resp.result);
      }
      return;
    }

    // Notification (Agent → Client, no id)
    if ('method' in msg && !('id' in msg)) {
      this.emit('notification', msg as JsonRpcNotification);
      return;
    }

    // Request (Agent → Client, has id and method — e.g. request_permission)
    if ('method' in msg && 'id' in msg) {
      this.emit('request', msg as JsonRpcRequest);
      return;
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error('ACP connection closed'));
    }
    this.emit('closed');
  }

  /** Send a request and await the response. */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP connection closed'));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.sendMessage(request);
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.sendMessage(notification);
  }

  /** Respond to an Agent → Client request. */
  respond(id: number | string, result: unknown): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.sendMessage(response);
  }

  /** Respond to an Agent → Client request with an error. */
  respondError(id: number | string, code: number, message: string): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message } };
    this.sendMessage(response);
  }

  private sendMessage(msg: JsonRpcMessage): void {
    const line = JSON.stringify(msg) + '\n';
    this.stdin.write(line, (err) => {
      if (err) {
        log.warn('acp', 'write-failed', { method: 'method' in msg ? msg.method : 'response', err: String(err) });
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Kill the underlying child process. On Windows, kills the entire
   *  process tree via `taskkill /T /F` to ensure child processes (MCP
   *  servers, etc.) don't keep the stdout pipe open. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === 'win32' && this.child.pid) {
      spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      }).on('error', (err) => {
        log.warn('acp', 'taskkill-error', { pid: this.child.pid, err: String(err) });
      });
      return;
    }
    this.child.kill(signal);
  }
}
