import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../platform/spawn';

export type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
export type JsonRpcId = string | number;

interface PendingRpc {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerInboundHandler {
  onNotification(method: string, params: unknown): void;
  onRequest(id: JsonRpcId, method: string, params: unknown): void;
  onMalformed(message: string): void;
}

export class JsonRpcRequestError extends Error {
  override readonly name = 'JsonRpcRequestError';

  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class AppServerTransport {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly handler: AppServerInboundHandler;
  private nextRequestId = 1;

  constructor(
    private readonly child: AppServerChild,
    handler: AppServerInboundHandler,
    private readonly requestTimeoutMs: number,
  ) {
    this.handler = handler;
    this.startReader();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcKey(id));
        reject(new JsonRpcRequestError(method, undefined, `${method} 握手超时`));
      }, this.requestTimeoutMs);
      this.pending.set(rpcKey(id), { method, resolve, reject, timer });
      this.write({ method, id, params }).catch((err) => {
        const pending = this.pending.get(rpcKey(id));
        if (!pending) return;
        this.pending.delete(rpcKey(id));
        clearTimeout(pending.timer);
        pending.reject(asError(err));
      });
    });
  }

  notify(method: string): Promise<void> {
    return this.write({ method });
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.write({ id, error: { code, message } });
  }

  sendRequest(method: string, params: unknown): Promise<void> {
    return this.write({ method, id: this.nextRequestId++, params });
  }

  rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private startReader(): void {
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let input: unknown;
      try {
        input = JSON.parse(trimmed);
      } catch {
        this.handler.onMalformed('Codex app-server 返回了畸形 JSON-RPC 消息');
        return;
      }
      this.handleMessage(input);
    });
  }

  private handleMessage(input: unknown): void {
    const message = recordValue(input);
    if (!message) {
      this.handler.onMalformed('Codex app-server 返回了畸形 JSON-RPC 消息');
      return;
    }
    const hasId = Object.hasOwn(message, 'id');
    const id = rpcId(message.id);
    if (hasId && id === undefined) {
      this.handler.onMalformed('Codex app-server 返回了非法 JSON-RPC id');
      return;
    }
    const hasMethod = Object.hasOwn(message, 'method');
    const method = nonEmptyString(message.method);
    if (hasMethod && !method) {
      this.handler.onMalformed('Codex app-server 返回了非法 JSON-RPC method');
      return;
    }
    if (id !== undefined && method === undefined) {
      this.handleResponse(id, message);
      return;
    }
    if (id !== undefined && method !== undefined) {
      this.handler.onRequest(id, method, message.params);
      return;
    }
    if (method !== undefined) {
      this.handler.onNotification(method, message.params);
      return;
    }
    this.handler.onMalformed('Codex app-server 返回了无法识别的 JSON-RPC 消息');
  }

  private handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const key = rpcKey(id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    const rpcError = recordValue(message.error);
    if (rpcError) {
      const code = finiteNumber(rpcError.code);
      pending.reject(new JsonRpcRequestError(
        pending.method,
        code,
        nonEmptyString(rpcError.message) ?? 'app-server 请求失败',
      ));
      return;
    }
    if (!Object.hasOwn(message, 'result')) {
      pending.reject(new JsonRpcRequestError(
        pending.method,
        undefined,
        'app-server 响应缺少 result',
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: Record<string, unknown>): Promise<void> {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      return Promise.reject(new Error('Codex app-server stdin 已关闭'));
    }
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export function rpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

export function rpcKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
