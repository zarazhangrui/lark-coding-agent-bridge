import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';

/**
 * Phase A adapter for the Devin CLI.
 *
 * Wraps `devin -p --prompt-file <tmp>` (non-interactive print mode) and
 * streams stdout as plain `text` deltas, then emits `final_text` + `done`.
 *
 * Limitations by design (Phase A):
 *   - No structured tool_use / tool_result events — `devin -p` has no
 *     `--output-format stream-json` equivalent. Tool calls happen inside the
 *     agent and surface only as part of the final text. Phase B will switch
 *     this adapter to `devin acp` (Agent Client Protocol over stdio) to get
 *     real streaming tool events.
 *   - No session resume (`--resume`) is wired, because the bridge's run-flow
 *     only sets `sessionId` for `agentId === 'claude'`. Phase B can enable
 *     `devin -r <session-id>` once the capability advertises native history.
 *   - No image input (`devin -p` has no stdin image protocol).
 *   - `--permission-mode dangerous` is hardcoded so non-interactive runs
 *     never block on an approval prompt. Phase B should map this from
 *     `profileConfig.permissions`.
 */
export interface DevinAdapterOptions {
  binary?: string;
  /** Hardcoded permission mode passed to `devin --permission-mode`. */
  permissionMode?: string;
  larkChannel?: LarkChannelEnvContext;
}

type DevinChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class DevinAdapter implements AgentAdapter {
  readonly id = 'devin';
  readonly displayName = 'Devin CLI';

  private readonly binary: string;
  private readonly permissionMode: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DevinAdapterOptions = {}) {
    this.binary = opts.binary ?? 'devin';
    this.permissionMode = opts.permissionMode ?? 'dangerous';
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
      agentId: 'devin',
      agentName: 'Devin CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for DevinAdapter.run');
    }

    // Pass the prompt via a temp file (--prompt-file) so no special
    // characters ever reach the Windows cmd.exe shim — same reason the
    // Claude adapter avoids argv for the prompt.
    const promptFile = writePromptFile(opts.prompt);

    const args = [
      '-p',
      '--prompt-file',
      promptFile.path,
      '--permission-mode',
      this.permissionMode,
    ];
    if (opts.model) args.push('--model', opts.model);
    // Phase A: no session resume. When Phase B enables it, gate on
    // opts.sessionId and push '--resume', opts.sessionId.

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as DevinChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
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
          runtimeError = new Error(`failed to spawn devin: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      promptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      promptFile.cleanup();
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
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
  child: DevinChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn devin: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  // `devin -p` writes the final answer to stdout as plain text. Stream it
  // chunk-by-chunk as `text` deltas so the Lark card shows a typewriter
  // effect, then emit a single `final_text` with the full accumulated
  // content so the final card has the complete answer.
  let accumulated = '';
  for await (const chunk of child.stdout) {
    const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
    if (!text) continue;
    accumulated += text;
    yield { type: 'text', delta: text };
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `devin runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
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
    yield {
      type: 'error',
      message: `devin exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (runtimeError) {
    yield {
      type: 'error',
      message: `devin runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  if (accumulated.trim()) {
    yield { type: 'final_text', content: accumulated };
  }
  yield { type: 'done', terminationReason: 'normal' };
}

function writePromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-devin-'));
  const path = join(dir, 'prompt.txt');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
