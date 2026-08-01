import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import pkg from '../../../package.json';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import {
  APP_SERVER_PROCESS_GROUP_ENABLED,
  buildAppServerProcessEnv,
  readAppServerConfigInventory,
  terminateAndReapChild,
  type CodexAppServerProcessOptions,
} from './app-server-process';
import { CodexAppServerJsonRpc, type CodexAppServerIncoming } from './app-server-jsonrpc';
import { assertMcpServersDisabled, buildLeanAppServerArgs } from './app-server-lean';

export { CodexAppServerRpcError } from './app-server-jsonrpc';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerClientOptions extends CodexAppServerProcessOptions {
  cwd: string;
  clientName?: string;
  clientTitle?: string;
  timeoutMs?: number;
}

export interface CodexAppServerConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Open a short-lived, lean app-server connection for deterministic control-plane
 * RPCs. The connection is initialized before `operation` runs and always reaped.
 */
export async function withCodexAppServerConnection<T>(
  options: CodexAppServerClientOptions,
  operation: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const env = buildAppServerProcessEnv(options);
  const inventory = await readAppServerConfigInventory({
    binary: options.binary,
    cwd: options.cwd,
    env,
  });
  const child = spawnProcess(options.binary, buildLeanAppServerArgs(inventory), {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: APP_SERVER_PROCESS_GROUP_ENABLED,
  }) as CodexAppServerChild;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let writeTail = Promise.resolve();
  const writeMessage = (message: unknown): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    const write = writeTail.then(
      () => new Promise<void>((resolve, reject) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          reject(new Error('codex app-server control connection stdin is closed'));
          return;
        }
        child.stdin.write(line, 'utf8', (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    );
    writeTail = write.catch(() => undefined);
    return write;
  };
  const rpc = new CodexAppServerJsonRpc(writeMessage);
  const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      rpc.fail(new Error(
        stderr.slice(0, 500) || `codex app-server control connection exited: ${code ?? signal ?? 'unknown'}`,
      ));
      readline.close();
      resolve();
    });
  });
  child.once('error', (err) => rpc.fail(err));
  child.stdin.on('error', (err) => rpc.fail(err));
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 64 * 1024) return;
    stderrChunks.push(chunk);
    stderrBytes += chunk.byteLength;
  });
  readline.on('line', (line) => receiveLine(line, rpc));

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connection: CodexAppServerConnection = {
    request: (method, params) => withTimeout(rpc.request(method, params), timeoutMs, method),
    notify: (method, params) => rpc.notify(method, params),
  };

  try {
    if (!child.pid) throw new Error('failed to spawn codex app-server control connection');
    await connection.request('initialize', {
      clientInfo: {
        name: options.clientName ?? 'lark-channel-bridge-task-controller',
        title: options.clientTitle ?? 'Lark Channel Bridge Task Controller',
        version: pkg.version,
      },
      capabilities: null,
    });
    await connection.notify('initialized');
    const response = recordValue(await connection.request('config/read', {
      includeLayers: false,
      cwd: options.cwd,
    }));
    const config = recordValue(response?.config);
    if (!config) throw new Error('codex app-server config/read returned no config');
    assertMcpServersDisabled(config.mcp_servers ?? config.mcpServers);
    return await operation(connection);
  } finally {
    await terminateAndReapChild(child, closed);
  }
}

function receiveLine(line: string, rpc: CodexAppServerJsonRpc): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_PROTOCOL_LINE_CHARS) {
    rpc.fail(new Error('codex app-server control connection emitted an oversized protocol line'));
    return;
  }
  try {
    const incoming = rpc.receive(JSON.parse(trimmed));
    if (incoming?.kind === 'request') rejectServerRequest(rpc, incoming);
  } catch (err) {
    rpc.fail(err);
  }
}

function rejectServerRequest(rpc: CodexAppServerJsonRpc, request: CodexAppServerIncoming): void {
  if (request.kind !== 'request') return;
  if (request.method === 'currentTime/read') {
    void rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  void rpc.respondError(request.id, -32601, `unsupported task-controller request: ${request.method}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
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
