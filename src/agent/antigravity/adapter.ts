import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildAntigravityArgs } from './argv';

export interface AntigravityAdapterOptions {
  binary: string;
  profileStateDir: string;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type AntigravityChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const CONVERSATION_ID_RE = /\b(?:Created conversation|conversationID=|conversationId=|conversation_id=)\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i;

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly displayName = 'Antigravity CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: AntigravityAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'antigravity',
      agentName: 'Antigravity CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'antigravity binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for AntigravityAdapter.run');
    }

    const logDir = join(this.profileStateDir, 'logs', 'antigravity');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = join(logDir, `${opts.runId}.log`);
    const args = buildAntigravityArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      conversationId: opts.threadId,
      model: opts.model,
      logFile,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as AntigravityChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasConversation: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      model: opts.model,
      logFile,
    });

    const stdoutQueue = new AsyncQueue<Buffer>();
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutQueue.push(chunk);
    });
    child.stdout.on('end', () => stdoutQueue.close());
    child.stdout.on('close', () => stdoutQueue.close());
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const line = chunk.toString('utf8').trim();
      if (line) log.warn('agent', 'stderr', { line });
    });
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stdoutQueue, stderrChunks, () => runtimeError, logFile, opts.threadId),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
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
      },
    };
  }
}

async function* createEventStream(
  child: AntigravityChild,
  stdoutQueue: AsyncQueue<Buffer>,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  logFile: string,
  existingConversationId?: string,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn antigravity: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  if (existingConversationId) {
    yield { type: 'system', threadId: existingConversationId };
  }

  let sawStdout = false;
  const stdoutDecoder = new StringDecoder('utf8');
  for await (const chunk of stdoutQueue) {
    const text = stdoutDecoder.write(chunk);
    if (!text.trim()) continue;
    sawStdout = true;
    yield { type: 'text', delta: text };
  }
  const finalText = stdoutDecoder.end();
  if (finalText.trim()) {
    sawStdout = true;
    yield { type: 'text', delta: finalText };
  }

  const exitCode = await waitForExitCode(child);
  const runtimeError = getError();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  const logText = await readLogFile(logFile);
  const conversationId = existingConversationId ?? extractConversationId(logText);
  if (conversationId && conversationId !== existingConversationId) {
    yield { type: 'system', threadId: conversationId };
  }

  if (exitCode !== 0 && exitCode !== null) {
    const detail = firstNonEmpty(stderr, extractLogError(logText));
    yield terminalError(`antigravity exited with code ${exitCode}${detail ? `: ${truncate(detail, 500)}` : ''}`);
    return;
  }
  if (runtimeError) {
    yield terminalError(`antigravity runtime error: ${runtimeError.message}`);
    return;
  }
  if (!sawStdout) {
    const detail = firstNonEmpty(stderr, extractLogError(logText));
    yield terminalError(
      detail
        ? `antigravity produced no output: ${truncate(detail, 500)}`
        : 'antigravity produced no output',
    );
    return;
  }
  yield { type: 'done', threadId: conversationId, terminationReason: 'normal' };
}

async function waitForExitCode(child: AntigravityChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function extractConversationId(text: string): string | undefined {
  return CONVERSATION_ID_RE.exec(text)?.[1];
}

function extractLogError(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    const match = /^E\d+.*?\]\s+(.*)$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim())?.trim();
}

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
