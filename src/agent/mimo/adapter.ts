import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
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
import { buildMimoArgs } from './argv';
import { MimoJsonlTranslator } from './jsonl';

export interface MimoAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /**
   * Forward `--thinking` so reasoning events appear in the JSONL stream
   * (translated to bridge `thinking` events for COT display). Default false —
   * reasoning costs tokens and most bridge profiles do not display it.
   */
  thinking?: boolean;
  stopGraceMs?: number;
  /**
   * mimo keeps running after the main answer is done: its background
   * checkpoint-writer distills the conversation into memory and the process
   * does not exit until the writer finishes (can take a minute+). The bridge
   * card would sit on "streaming" the whole time. To surface the answer
   * promptly, treat a long silence after the last streaming event (text /
   * reasoning / tool_use) as completion: emit `done` and SIGTERM the child,
   * letting the writer's partial state be rebuilt next time. Default 25s.
   */
  idleTimeoutMs?: number;
}

type MimoChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class MimoAdapter implements AgentAdapter {
  readonly id = 'mimo';
  readonly displayName = 'MiMo Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly thinking: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly idleTimeoutMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: MimoAdapterOptions = {}) {
    this.binary = opts.binary ?? 'mimo';
    this.larkChannel = opts.larkChannel;
    this.thinking = opts.thinking === true;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 25_000;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'mimo',
      agentName: 'MiMo Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for MimoAdapter.run');
    }

    // The bridge system prompt and the user message both go on stdin as a
    // prefixed prompt (mimo reads the message from stdin; there is no
    // append-system-prompt file flag like claude's). skipPermissions maps the
    // bridge access mode (forwarded as the codex-style sandbox field): full
    // -> --dangerously-skip-permissions; anything stricter leaves the flag
    // off and mimo decides on its own.
    const args = buildMimoArgs({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      model: opts.model,
      thinking: this.thinking,
      skipPermissions: opts.sandbox === 'danger-full-access',
      images: opts.images,
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as MimoChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

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
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn mimo: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
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
    let stopReason: 'interrupted' | undefined;

    return {
      runId: opts.runId,
      events: createEventStream(
        child,
        stderrChunks,
        () => runtimeError,
        () => stopReason,
        this.idleTimeoutMs,
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
  child: MimoChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => 'interrupted' | undefined,
  idleTimeoutMs: number,
): AsyncGenerator<AgentEvent> {
  const translator = new MimoJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn mimo: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // mimo keeps the process alive for its background checkpoint-writer after
  // the main answer is done, emitting no streaming events meanwhile. A silent
  // window past idleTimeoutMs means the answer is complete: finish normally
  // and SIGTERM the child so the bridge card doesn't sit on "streaming".
  let lastStreamingAt = 0;
  let idleTerminated = false;
  const idleTimer = setInterval(() => {
    if (
      !idleTerminated &&
      lastStreamingAt > 0 &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() - lastStreamingAt > idleTimeoutMs
    ) {
      idleTerminated = true;
      log.warn('agent', 'idle-finish', {
        pid: child.pid ?? null,
        idleMs: Date.now() - lastStreamingAt,
      });
      child.kill('SIGTERM');
    }
  }, 1000);
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // mimo prints database-migration / progress text to stdout before the
        // JSONL stream starts; skip non-JSON lines.
        continue;
      }
      const events = translator.translate(parsed);
      for (const evt of events) {
        if (evt.type === 'text' || evt.type === 'thinking' || evt.type === 'tool_use') {
          lastStreamingAt = Date.now();
        }
      }
      yield* events;
    }
  } finally {
    clearInterval(idleTimer);
    rl.close();
  }

  if (idleTerminated) {
    yield* translator.finish('normal');
    return;
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`mimo runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`mimo exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`mimo runtime error: ${runtimeError.message}`);
    return;
  }

  // mimo signals completion only by exiting; no terminal stream event exists.
  yield* translator.finish('normal');
}

async function waitForExitCode(child: MimoChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
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
