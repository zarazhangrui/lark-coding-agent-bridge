import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
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
import { CodexJsonlTranslator, type CodexFinishReason } from '../codex/jsonl';
import { buildTraeArgs } from './argv';

export interface TraeAdapterOptions {
  binary: string;
  profileStateDir: string;
  traeHome?: string;
  inheritTraeHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type TraeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class TraeAdapter implements AgentAdapter {
  readonly id = 'trae';
  readonly displayName = 'Trae CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly traeHome: string | undefined;
  private readonly inheritTraeHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: TraeAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.traeHome = opts.traeHome;
    this.inheritTraeHome = opts.inheritTraeHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
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
      agentId: 'trae',
      agentName: 'Trae CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'trae binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for TraeAdapter.run');
    }

    const args = buildTraeArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.traeHome) {
      envOverrides.TRAE_HOME = this.traeHome;
    } else if (!this.inheritTraeHome) {
      envOverrides.TRAE_HOME = join(this.profileStateDir, 'trae-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as TraeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    const threadCapture = new ThreadIdCapture(opts.threadId);
    const handleStderrLine = (line: string): void => {
      if (line.trim()) log.warn('agent', 'stderr', { line });
      threadCapture.ingest(line);
      if (isWindowsCommandNotFoundLine(line)) {
        runtimeError = new Error(`failed to spawn trae: ${line.trim()}`);
        child.stdout.destroy();
        child.kill();
      }
    };
    const flushStderrBuffer = (): void => {
      if (!stderrBuffer) return;
      const line = stderrBuffer;
      stderrBuffer = '';
      handleStderrLine(line);
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        handleStderrLine(line);
        nl = stderrBuffer.indexOf('\n');
      }
    });
    child.stderr.once('end', flushStderrBuffer);

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      flushStderrBuffer();
      threadCapture.close();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(
        child,
        stderrChunks,
        () => runtimeError,
        () => stopReason,
        threadCapture,
        opts.runId,
        opts.cwd,
      ),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
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
  child: TraeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
  threadCapture: ThreadIdCapture,
  runId: string,
  cwd: string,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  let emittedThreadId = false;
  let missingThreadIdWarned = false;
  const filterTranslatedEvents = (events: AgentEvent[]): AgentEvent[] => {
    const filtered: AgentEvent[] = [];
    for (const event of events) {
      if (event.type === 'system' && event.threadId) {
        if (emittedThreadId) continue;
        emittedThreadId = true;
      }
      filtered.push(event);
    }
    return filtered;
  };
  const translateCapturedThread = (): AgentEvent[] => {
    const threadId = threadCapture.current();
    if (!threadId || emittedThreadId) return [];
    return filterTranslatedEvents(translator.translate({ type: 'thread.started', thread_id: threadId }));
  };
  const warnMissingThreadId = (): void => {
    if (threadCapture.current() || missingThreadIdWarned) return;
    missingThreadIdWarned = true;
    log.warn('agent', 'trae-session-id-missing', {
      runId,
      cwd,
      hint: 'Trae resume will be unavailable for this run',
    });
  };
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn trae: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let waitedForThreadBeforeStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    closeSilentStdout();
  } else {
    child.once('exit', closeSilentStdout);
  }
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const isTraeSessionEvent = isTraeSessionStartedEvent(parsed);
      threadCapture.ingestJsonl(parsed);
      if (!emittedThreadId && !threadCapture.current() && !waitedForThreadBeforeStdout) {
        waitedForThreadBeforeStdout = true;
        await threadCapture.wait(2000);
      }
      yield* translateCapturedThread();
      if (isTraeSessionEvent) continue;
      if (isTerminalJsonlEvent(parsed) && !emittedThreadId) {
        await threadCapture.wait(2000);
        yield* translateCapturedThread();
      }
      yield* filterTranslatedEvents(translator.translate(parsed));
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield terminalError(`trae runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  yield* translateCapturedThread();
  if (stopReason) {
    warnMissingThreadId();
    yield* filterTranslatedEvents(translator.finish(stopReason));
    return;
  }
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield terminalError(`trae exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError) {
    yield terminalError(`trae runtime error: ${runtimeError.message}`);
    return;
  }
  warnMissingThreadId();
  if (!translator.terminalEmitted()) {
    yield* filterTranslatedEvents(translator.finish());
  }
}

function waitForExitCode(child: TraeChild): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });
}

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

class ThreadIdCapture {
  private threadId: string | undefined;
  private closed = false;
  private readonly waiters: Array<(value: string | undefined) => void> = [];

  constructor(initialThreadId?: string) {
    this.threadId = initialThreadId;
  }

  ingest(line: string): void {
    if (this.threadId) return;
    const threadId = extractTraeThreadId(line);
    if (!threadId) return;
    this.threadId = threadId;
    this.resolve();
  }

  ingestJsonl(value: unknown): void {
    if (this.threadId) return;
    const threadId = extractTraeThreadIdFromRecord(value);
    if (!threadId) return;
    this.threadId = threadId;
    this.resolve();
  }

  current(): string | undefined {
    return this.threadId;
  }

  close(): void {
    this.closed = true;
    this.resolve();
  }

  wait(timeoutMs: number): Promise<string | undefined> {
    if (this.threadId || this.closed) return Promise.resolve(this.threadId);
    return new Promise((resolve) => {
      let waiter: ((value: string | undefined) => void) | undefined;
      const timer = setTimeout(() => {
        if (waiter) this.removeWaiter(waiter);
        resolve(this.threadId);
      }, timeoutMs);
      waiter = (value: string | undefined): void => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }

  private resolve(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter(this.threadId);
  }

  private removeWaiter(waiter: (value: string | undefined) => void): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

function extractTraeThreadId(line: string): string | undefined {
  const textMatch =
    /\b(?:thread_id|threadId|session_id|sessionId)\s*[=:]\s*["']?([0-9a-fA-F-]{20,})\b/.exec(
      line,
    );
  if (isTraeThreadId(textMatch?.[1])) return textMatch[1];

  const jsonStart = line.indexOf('{');
  if (jsonStart < 0) return undefined;
  try {
    return extractTraeThreadIdFromRecord(JSON.parse(line.slice(jsonStart)));
  } catch {
    return undefined;
  }
}

function extractTraeThreadIdFromRecord(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const id = raw.thread_id ?? raw.threadId ?? raw.session_id ?? raw.sessionId;
  return isTraeThreadId(id) ? id : undefined;
}

function isTraeThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F-]{20,}$/.test(value);
}

function isTraeSessionStartedEvent(value: unknown): boolean {
  return typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'session.started';
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line);
}

function isTerminalJsonlEvent(value: unknown): boolean {
  return typeof value === 'object' &&
    value !== null &&
    ((value as { type?: unknown }).type === 'turn.completed' ||
      (value as { type?: unknown }).type === 'turn.failed');
}
