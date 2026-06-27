import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { PiJsonTranslator, type PiFinishReason } from './stream-json';

export interface PiAdapterOptions {
  binary: string;
  /** Profile state dir; used to derive an isolated PI_CODING_AGENT_DIR. */
  profileStateDir: string;
  /** Default model if the run does not specify one. */
  model?: string;
  /** Explicit isolated config dir (overrides profileStateDir/pi-agent). */
  piAgentDir?: string;
  /** When false (default), isolate PI_CODING_AGENT_DIR under the profile. */
  inheritPiAgentDir?: boolean;
  /** Gateway provider override written to models.json (decision F). */
  gatewayBaseUrl?: string;
  /** Env var name whose value backs the models.json apiKey template. */
  gatewayApiKeyEnv?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type PiChild = SpawnedProcessByStdio<null, Readable, Readable>;

/**
 * Bridges pi (`@earendil-works/pi-coding-agent`) as a third agent.
 *
 * Spawn shape mirrors ClaudeAdapter: prompt is a `-p` CLI arg (NOT stdin like
 * codex), so stdin is 'ignore'; stdout is pure NDJSON because pi's non-interactive
 * mode hijacks process.stdout (takeOverStdout) and redirects everything else to
 * stderr. The system prompt is injected via `--append-system-prompt` (same flag
 * name as claude), so the bridge's run conventions append to pi's default
 * coding-assistant prompt.
 *
 * Termination follows CodexAdapter's stopReason + translator.finish() pattern:
 * SIGTERM does NOT guarantee pi flushes its async NDJSON queue (print-mode exits
 * 143 from the signal handler before the finally-block flush runs), so on stop()
 * we set stopReason='interrupted' and let finish() synthesize the terminal event
 * — never relying on pi to emit agent_end after a kill.
 */
export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'pi coding agent';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly model: string | undefined;
  private readonly piAgentDir: string | undefined;
  private readonly inheritPiAgentDir: boolean;
  private readonly gatewayBaseUrl: string | undefined;
  private readonly gatewayApiKeyEnv: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.model = opts.model;
    this.piAgentDir = opts.piAgentDir;
    // default true (inherit): reuse the user's existing ~/.pi config, mirroring
    // CodexAdapter's inheritCodexHome. Only isolate when explicitly requested.
    this.inheritPiAgentDir = opts.inheritPiAgentDir !== false;
    this.gatewayBaseUrl = opts.gatewayBaseUrl;
    this.gatewayApiKeyEnv = opts.gatewayApiKeyEnv;
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
      agentId: 'pi',
      agentName: 'pi coding agent',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    // Ensure the isolated PI_CODING_AGENT_DIR exists and, when a gateway is
    // configured, write a models.json provider override (decision F). The
    // file carries an env-var template, NOT a literal secret.
    if (this.piAgentDir || !this.inheritPiAgentDir) {
      const dir = this.piAgentDir ?? join(this.profileStateDir, 'pi-agent');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (this.gatewayBaseUrl) {
        await writeModelsJson(dir, this.gatewayBaseUrl, this.gatewayApiKeyEnv);
      }
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiAdapter.run');
    }

    const args = this.buildArgs(opts);
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    // Isolate pi's config/auth per bridge profile (mirrors CodexAdapter's
    // CODEX_HOME). pi reads auth.json/models.json/settings.json all from
    // PI_CODING_AGENT_DIR, so one env var redirects everything.
    if (this.piAgentDir) {
      envOverrides.PI_CODING_AGENT_DIR = this.piAgentDir;
    } else if (!this.inheritPiAgentDir) {
      envOverrides.PI_CODING_AGENT_DIR = join(this.profileStateDir, 'pi-agent');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as PiChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model ?? this.model,
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
          runtimeError = new Error(`failed to spawn pi: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: PiFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
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

  private buildArgs(opts: AgentRunOptions): string[] {
    const args = [
      '-p',
      opts.prompt,
      '--mode',
      'json',
      '--append-system-prompt',
      buildBridgeSystemPrompt(this.botIdentity),
    ];
    if (opts.sessionId) {
      // `--session <id>` resumes a prior session (closest to claude --resume).
      // Do NOT use --session-id: it cannot combine with --session/--resume
      // (main.ts validateSessionIdFlags) and creates an id if missing.
      args.push('--session', opts.sessionId);
    }
    // New conversation: pass NO session flag so pi creates AND persists a
    // session by default. --no-session would make it ephemeral, so the id
    // emitted in the session header would not survive for resume next turn
    // (causing "No session found" on the second message).
    const model = opts.model ?? this.model;
    if (model) args.push('--model', model);
    return args;
  }
}

async function* createEventStream(
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => PiFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn pi: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
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
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield terminalError(`pi runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);

  // stop() was invoked: synthesize the terminal event regardless of pi's
  // (possibly truncated) stdout. SIGTERM exits 143 — do NOT treat as a hard
  // error when the stop was intentional.
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
      yield terminalError(`pi exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield terminalError(`pi runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

async function waitForExitCode(child: PiChild): Promise<number | null> {
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

/**
 * Write a models.json custom-provider override into the isolated pi config dir
 * (decision F). `apiKey` is an env-var template resolved by pi at runtime, so
 * the file itself contains no secret. Without this, pi only sees built-in
 * providers and cannot reach a GLM/compatible anthropic gateway.
 */
async function writeModelsJson(
  agentDir: string,
  baseUrl: string,
  apiKeyEnv?: string,
): Promise<void> {
  const apiKeyTemplate = apiKeyEnv ? `\${${apiKeyEnv}}` : undefined;
  const models = {
    providers: {
      anthropic: {
        baseUrl,
        ...(apiKeyTemplate ? { apiKey: apiKeyTemplate } : {}),
      },
    },
  };
  await writeFileAtomic(join(agentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, {
    mode: 0o600,
  });
}
