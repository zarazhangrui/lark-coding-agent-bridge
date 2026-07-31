import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import pkg from '../../../package.json';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { CodexAppServerJsonRpc } from './app-server-jsonrpc';
import {
  buildLeanAppServerArgs,
  parseCodexFeatureList,
  type CodexAppServerConfigInventory,
} from './app-server-lean';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerProcessOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  larkChannel?: LarkChannelEnvContext;
}

export interface AppServerConfigProbeInput {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const RPC_TIMEOUT_MS = 15_000;
const FEATURE_LIST_TIMEOUT_MS = 5_000;
const MAX_PROTOCOL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_FEATURE_LIST_CHARS = 1024 * 1024;

export async function readAppServerConfigInventory(
  input: AppServerConfigProbeInput,
): Promise<CodexAppServerConfigInventory> {
  const features = await readAppServerFeatureInventory(input);
  const child = spawnProcess(input.binary, buildLeanAppServerArgs({ features }), {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let writeTail = Promise.resolve();
  const writeMessage = (message: unknown): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    const operation = writeTail.then(
      () => new Promise<void>((resolve, reject) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          reject(new Error('codex app-server config probe stdin is closed'));
          return;
        }
        child.stdin.write(line, 'utf8', (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    );
    writeTail = operation.catch(() => undefined);
    return operation;
  };
  const rpc = new CodexAppServerJsonRpc(writeMessage);
  const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      rpc.fail(new Error(
        stderr.slice(0, 500) || `codex app-server config probe exited: ${code ?? signal ?? 'unknown'}`,
      ));
      readline.close();
      resolve();
    });
  });
  child.once('error', (err) => rpc.fail(err));
  child.stdin.on('error', (err) => rpc.fail(err));
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 16 * 1024) return;
    stderrChunks.push(chunk);
    stderrBytes += chunk.byteLength;
  });
  readline.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_PROTOCOL_LINE_CHARS) {
      rpc.fail(new Error('codex app-server config probe emitted an oversized protocol line'));
      return;
    }
    try {
      const incoming = rpc.receive(JSON.parse(trimmed));
      if (incoming?.kind === 'request') {
        void rpc.respondError(incoming.id, -32601, `unsupported config probe request: ${incoming.method}`);
      }
    } catch (err) {
      rpc.fail(err);
    }
  });

  try {
    if (!child.pid) throw new Error('failed to spawn codex app-server config probe');
    await withTimeout(
      rpc.request('initialize', {
        clientInfo: {
          name: 'lark-channel-bridge-config-probe',
          title: 'Lark Channel Bridge Config Probe',
          version: pkg.version,
        },
        capabilities: null,
      }),
      RPC_TIMEOUT_MS,
      'config probe initialize',
    );
    await rpc.notify('initialized');
    const response = recordValue(await withTimeout(
      rpc.request('config/read', { includeLayers: false, cwd: input.cwd }),
      RPC_TIMEOUT_MS,
      'config/read',
    ));
    const config = recordValue(response?.config);
    if (!config) throw new Error('codex app-server config/read returned no config');
    return { features, mcp_servers: config.mcp_servers ?? config.mcpServers };
  } finally {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    if (!(await waitForPromise(closed, 500))) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!(await waitForPromise(closed, 500)) && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForPromise(closed, 500);
      }
    }
  }
}

export async function readAppServerFeatureInventory(
  input: AppServerConfigProbeInput,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawnProcess(input.binary, ['features', 'list'], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      settled = true;
      reject(new Error(`codex features list timed out after ${FEATURE_LIST_TIMEOUT_MS}ms`));
    }, FEATURE_LIST_TIMEOUT_MS);
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_FEATURE_LIST_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => finish(() => reject(err)));
    child.once('close', (code, signal) => finish(() => {
      if (code !== 0) {
        reject(new Error(
          stderr.trim().slice(0, 500)
            || `codex features list exited: ${code ?? signal ?? 'unknown'}`,
        ));
        return;
      }
      const features = parseCodexFeatureList(stdout);
      if (features.length === 0) {
        reject(new Error('codex features list returned no parseable feature inventory'));
        return;
      }
      resolve(features);
    }));
  });
}

export function buildAppServerProcessEnv(options: CodexAppServerProcessOptions): NodeJS.ProcessEnv {
  const envOverrides = buildLarkChannelEnv(options.larkChannel);
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return mergeProcessEnv(process.env, envOverrides);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
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
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
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
