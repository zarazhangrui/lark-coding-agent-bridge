import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { writeSystemPromptFile } from '../system-prompt-file';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildOmpArgs } from './argv';
import { OmpRpcFrameDecoder, OmpRpcTranslator, type OmpFinishReason } from './rpc';

export interface OmpAdapterOptions {
  binary?: string;
  stopGraceMs?: number;
  /** How long to wait for OMP's RPC `ready` frame before giving up. */
  readyTimeoutMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type OmpChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface OmpRunState {
  ready: boolean;
  readyTimer: ReturnType<typeof setTimeout> | undefined;
  stopReason: Extract<OmpFinishReason, 'interrupted' | 'timeout'> | undefined;
}

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DRAIN_AFTER_TERMINAL_MS = 1500;
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'ask']);

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';

  private readonly binary: string;
  private readonly defaultStopGraceMs: number;
  private readonly readyTimeoutMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OmpAdapterOptions = {}) {
    this.binary = opts.binary ?? 'omp';
    this.defaultStopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
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
      agentId: 'omp',
      agentName: 'Oh My Pi',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OmpAdapter.run');
    }

    const systemPromptFile = writeSystemPromptFile(
      buildBridgeSystemPrompt(this.botIdentity),
      { prefix: 'lark-omp-' },
    );
    const args = buildOmpArgs({
      systemPromptFile: systemPromptFile.path,
      sessionId: opts.sessionId,
      model: opts.model,
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OmpChild;

    log.info('agent', 'spawn', {
      agent: 'omp',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model ?? null,
    });

    const state: OmpRunState = { ready: false, readyTimer: undefined, stopReason: undefined };
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { agent: 'omp', line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn omp: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'omp', pid: child.pid ?? null, code, signal });
      if (state.readyTimer) {
        clearTimeout(state.readyTimer);
        state.readyTimer = undefined;
      }
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { agent: 'omp', message: err.message });
    });

    if (!child.pid) {
      // spawn failed synchronously; the stream reports the runtime error.
      systemPromptFile.cleanup();
    } else {
      state.readyTimer = setTimeout(() => {
        if (state.ready) return;
        runtimeError = new Error(
          `omp RPC did not become ready within ${this.readyTimeoutMs}ms`,
        );
        log.warn('agent', 'omp-ready-timeout', { pid: child.pid ?? null });
        child.kill('SIGTERM');
      }, this.readyTimeoutMs);
    }

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    const send = (frame: Record<string, unknown>): boolean => writeFrame(child, frame);

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, state, send, opts),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        state.stopReason = 'interrupted';
        log.info('agent', 'stop-abort', { agent: 'omp', pid: child.pid ?? null, graceMs: stopGraceMs });
        send({ id: `abort-${opts.runId}`, type: 'abort' });

        // Give OMP a moment to abort the turn and exit on its own. As with the
        // Claude adapter, a live subprocess (lark-cli OAuth, long bash) may
        // still need a signal, so escalate through stdin close → SIGTERM.
        if (await waitForExit(child, Math.min(stopGraceMs, 1000))) return;
        try {
          child.stdin.end();
        } catch {
          // stdin may already be closed.
        }
        if (await waitForExit(child, stopGraceMs)) return;

        log.info('agent', 'stop-sigterm', { agent: 'omp', pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        if (await waitForExit(child, stopGraceMs)) return;

        log.warn('agent', 'stop-sigkill', {
          agent: 'omp',
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          reason: 'grace-period-expired',
        });
        child.kill('SIGKILL');
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExit(child, timeoutMs);
      },
    };
  }
}

async function* createEventStream(
  child: OmpChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  state: OmpRunState,
  send: (frame: Record<string, unknown>) => boolean,
  opts: AgentRunOptions,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn omp: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const decoder = new OmpRpcFrameDecoder();
  const translator = new OmpRpcTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let promptSent = false;
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);

  const sendPrompt = (): void => {
    if (promptSent) return;
    promptSent = true;
    const images = readImages(opts.images);
    const frame: Record<string, unknown> = {
      id: `prompt-${opts.runId}`,
      type: 'prompt',
      message: opts.prompt,
    };
    if (images.length > 0) frame.images = images;
    if (!send(frame)) {
      log.warn('agent', 'omp-prompt-write-failed', { pid: child.pid ?? null });
    }
  };

  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let frame: unknown;
      try {
        frame = decoder.decode(trimmed);
      } catch (err) {
        log.warn('agent', 'omp-rpc-frame-error', {
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (frame === undefined) continue;
      if (!isRecord(frame) || typeof frame.type !== 'string') continue;

      if (frame.type === 'ready') {
        state.ready = true;
        if (state.readyTimer) {
          clearTimeout(state.readyTimer);
          state.readyTimer = undefined;
        }
        decoder.setMaxReassembledBytes(frame.maxReassembledFrameBytes);
        const supported = Array.isArray(frame.supportedProtocolVersions)
          ? frame.supportedProtocolVersions
          : [];
        if (supported.includes(2)) {
          send({
            id: `protocol-${opts.runId}`,
            type: 'negotiate_protocol',
            protocolVersion: 2,
          });
        }
        send({ id: `state-${opts.runId}`, type: 'get_state' });
        sendPrompt();
        continue;
      }

      if (frame.type === 'extension_ui_request') {
        respondToUiRequest(frame, send);
        continue;
      }

      for (const event of translator.translate(frame)) {
        yield event;
      }
      if (translator.terminalEmitted()) {
        try {
          child.stdin.end();
        } catch {
          // best-effort graceful shutdown
        }
        return;
      }
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = undefined;
    }
    child.removeListener('exit', closeSilentStdout);
    const terminal = translator.terminalEmitted();
    if (terminal) {
      try {
        child.stdin.end();
      } catch {
        // best-effort graceful shutdown
      }
    }
    rl.close();
    // OMP MUST keep draining stdout after stdin closes: a client that leaves
    // the pipe unread can delay its exit indefinitely. The bridge stops
    // consuming on the terminal event, so drain here to let OMP dispose the
    // session before the run executor's post-done grace expires.
    if (terminal) await drainStdout(child);
  }

  if (translator.terminalEmitted()) return;

  if (state.stopReason) {
    yield* translator.finish(state.stopReason);
    return;
  }

  const runtimeError = getError();
  if (runtimeError) {
    yield* translator.fail(`omp runtime error: ${runtimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield* translator.fail(`omp exited with code ${exitCode}${detail}`);
    return;
  }

  if (!state.ready) {
    yield* translator.fail('omp RPC did not become ready');
    return;
  }
  if (translator.endedAfterAgentYield()) {
    yield* translator.finish('normal');
    return;
  }
  yield* translator.finish('failed');
}

function respondToUiRequest(
  frame: Record<string, unknown>,
  send: (frame: Record<string, unknown>) => boolean,
): void {
  const method = typeof frame.method === 'string' ? frame.method : undefined;
  const id = typeof frame.id === 'string' ? frame.id : undefined;
  if (method === 'open_url') {
    // A host-issued login flow: the bridge has no browser surface, so surface
    // the URL in the log for the operator instead of silently dropping it.
    log.warn('agent', 'omp-login-url', {
      url: typeof frame.url === 'string' ? frame.url : null,
      launchUrl: typeof frame.launchUrl === 'string' ? frame.launchUrl : null,
    });
    return;
  }
  if (!id || !method || !DIALOG_UI_METHODS.has(method)) return;
  send({ type: 'extension_ui_response', id, cancelled: true });
}

function writeFrame(child: OmpChild, frame: Record<string, unknown>): boolean {
  const stdin = child.stdin;
  if (!stdin.writable || stdin.destroyed) return false;
  try {
    stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch (err) {
    log.warn('agent', 'omp-rpc-write-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function readImages(paths: readonly string[] | undefined) {
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const path of paths ?? []) {
    try {
      images.push({
        type: 'image',
        data: readFileSync(path).toString('base64'),
        mimeType: mimeTypeForPath(path),
      });
    } catch (err) {
      log.warn('agent', 'omp-image-read-failed', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return images;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

async function drainStdout(child: OmpChild): Promise<void> {
  if (child.stdout.readableEnded || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stdout.removeListener('end', done);
      child.removeListener('exit', done);
      resolve();
    };
    const onData = (): void => {};
    const timer = setTimeout(done, DRAIN_AFTER_TERMINAL_MS);
    child.stdout.on('data', onData);
    child.stdout.once('end', done);
    child.once('exit', done);
    child.stdout.resume();
  });
}

async function waitForExit(child: OmpChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
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

async function waitForExitCode(child: OmpChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
