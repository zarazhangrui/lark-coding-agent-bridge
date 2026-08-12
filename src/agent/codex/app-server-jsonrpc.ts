/**
 * The Codex app-server speaks newline-delimited JSON-RPC without a `jsonrpc`
 * version field.  This class deliberately only owns request/response
 * multiplexing.  Process lifecycle and notification routing live in the
 * shared client so one connection can service multiple turns.
 */

export type JsonRpcId = number | string;

export type CodexAppServerIncoming =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

export class CodexAppServerRpcError extends Error {
  readonly method: string;
  readonly code: number | string | undefined;
  readonly data: unknown;

  constructor(method: string, message: string, code?: number | string, data?: unknown) {
    super(message);
    this.name = 'CodexAppServerRpcError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Small, reusable app-server JSONL multiplexer.  Calls are safe to issue
 * concurrently; each response is matched by its numeric request id.
 */
export class CodexAppServerJsonRpc {
  private readonly writeMessage: (message: unknown) => Promise<void>;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closedError: Error | undefined;

  constructor(writeMessage: (message: unknown) => Promise<void>) {
    this.writeMessage = writeMessage;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    const message = params === undefined ? { method, id } : { method, id, params };
    void this.writeMessage(message).catch((error: unknown) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(asError(error, `failed to write ${method} request`));
    });
    return response;
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return this.writeMessage(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return this.writeMessage({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return this.writeMessage({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  /** Feed one already parsed line into the multiplexer. */
  receive(input: unknown): CodexAppServerIncoming | undefined {
    const message = recordValue(input);
    if (!message) throw new Error('codex app-server emitted a non-object message');

    if (typeof message.method === 'string') {
      if (isJsonRpcId(message.id)) {
        return {
          kind: 'request',
          id: message.id,
          method: message.method,
          params: message.params,
        };
      }
      return { kind: 'notification', method: message.method, params: message.params };
    }

    if (!isJsonRpcId(message.id)) {
      throw new Error('codex app-server message has neither method nor response id');
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      throw new Error(`codex app-server returned an unknown response id: ${String(message.id)}`);
    }
    this.pending.delete(message.id);
    if (Object.prototype.hasOwnProperty.call(message, 'error')) {
      const error = recordValue(message.error);
      pending.reject(
        new CodexAppServerRpcError(
          pending.method,
          stringValue(error?.message) ?? `codex app-server rejected ${pending.method}`,
          numberOrStringValue(error?.code),
          error?.data,
        ),
      );
    } else if (Object.prototype.hasOwnProperty.call(message, 'result')) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(`codex app-server returned a malformed ${pending.method} response`));
    }
    return undefined;
  }

  /** Reject all outstanding requests after a transport/process failure. */
  fail(error: unknown): void {
    if (this.closedError) return;
    this.closedError = asError(error, 'codex app-server connection closed');
    for (const pending of this.pending.values()) pending.reject(this.closedError);
    this.pending.clear();
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(error === undefined ? fallback : String(error));
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function numberOrStringValue(value: unknown): number | string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// Kept as a re-export for callers/tests that historically imported both the
// wire multiplexer and event translator from this module.
export { CodexAppServerEventTranslator } from './app-server-translator';
export type {
  AppServerFinishReason as CodexAppServerFinishReason,
  AppServerProtocolDriftState as CodexAppServerProtocolDriftState,
} from './app-server-translator';
