import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { CodexReasoningEffort } from '../../config/schema';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { CODEX_BRIDGE_PROMPT } from './bridge-prompt';
import { translateEvent } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
  /** Reasoning effort passed as `-c model_reasoning_effort=<value>`. */
  reasoningEffort?: CodexReasoningEffort;
}

/** Per-run Codex config that isn't part of the generic AgentRunOptions. */
interface CodexRunConfig {
  reasoningEffort?: CodexReasoningEffort;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Map the adapter's permission mode onto Codex's sandbox/approval flags.
 * Default (undefined) matches the Claude adapter's default — fully
 * autonomous — since the bridge runs headless with no human to approve.
 *
 * `codex exec resume` accepts ONLY the bypass flag, not `-s <mode>` — so on
 * resume we emit nothing for the sandbox modes and let the persisted session
 * keep its original policy. (`-C` is likewise exec-only; see buildCodexArgs.)
 */
function permissionArgs(mode: AgentRunOptions['permissionMode'], resuming: boolean): string[] {
  switch (mode) {
    case 'plan':
      return resuming ? [] : ['-s', 'read-only'];
    case 'acceptEdits':
    case 'default':
      return resuming ? [] : ['-s', 'workspace-write'];
    default:
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/**
 * Build the argv (after the `codex` binary) for one run. Pure + exported so
 * the flag mapping and prompt injection are unit-testable without spawning.
 *
 * New session: `exec [flags] "<bridge prompt + user prompt>"`.
 * Resume:      `exec resume <id> [flags] "<user prompt>"` — no re-injection,
 *              the persisted thread already carries the conventions.
 */
export function buildCodexArgs(opts: AgentRunOptions, cfg: CodexRunConfig = {}): string[] {
  const resuming = Boolean(opts.sessionId);
  const args = resuming ? ['exec', 'resume', opts.sessionId as string] : ['exec'];
  args.push('--json', '--skip-git-repo-check');
  // `-C/--cd` is an exec-only flag; `codex exec resume` rejects it. On resume
  // the working directory comes from the spawned process's cwd instead.
  if (!resuming && opts.cwd) args.push('-C', opts.cwd);
  args.push(...permissionArgs(opts.permissionMode, resuming));
  if (opts.model) args.push('-m', opts.model);
  if (cfg.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${cfg.reasoningEffort}"`);
  }

  const prompt = resuming ? opts.prompt : `${CODEX_BRIDGE_PROMPT}${opts.prompt}`;
  args.push(prompt);
  return args;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly reasoningEffort?: CodexReasoningEffort;

  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
    this.reasoningEffort = opts.reasoningEffort;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = buildCodexArgs(opts, { reasoningEffort: this.reasoningEffort });

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      agent: 'codex',
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before we return — the
    // 'error'/exit events can fire in the next tick; deferring to the async
    // generator body would let them fire into the void and hang the stream.
    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
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
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
