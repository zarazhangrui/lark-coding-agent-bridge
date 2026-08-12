import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { CodexTransport, SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
  splitBridgePromptForAppServer,
} from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildCodexArgs } from './argv';
import { CodexAppServerClient } from './app-server-client';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';

export interface CodexAdapterOptions {
  binary: string;
  transport?: CodexTransport;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName: string;

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly transport: CodexTransport;
  private readonly appServer: CodexAppServerClient | undefined;
  private appServerProtocolCheck: Promise<void> | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.transport = opts.transport ?? 'exec';
    this.displayName = this.transport === 'app-server' ? 'Codex App Server' : 'Codex CLI';
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    if (this.transport === 'app-server') {
      if (this.ignoreUserConfig || this.ignoreRules) {
        throw new Error(
          'codex app-server transport requires ignoreUserConfig=false and ignoreRules=false',
        );
      }
      this.appServer = new CodexAppServerClient({
        binary: this.binary,
        profileStateDir: this.profileStateDir,
        ...(this.codexHome ? { codexHome: this.codexHome } : {}),
        inheritCodexHome: this.inheritCodexHome,
        stopGraceMs: this.defaultStopGraceMs,
        ...(this.larkChannel ? { larkChannel: this.larkChannel } : {}),
      });
    }
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    if (this.appServer) {
      await this.appServer.prepare();
      return;
    }
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  async warmup(cwd: string): Promise<void> {
    if (!this.appServer) return;
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    this.appServerProtocolCheck ??= verifyAppServerProtocol(this.binary);
    await this.appServerProtocolCheck;
    await this.appServer.prime(cwd, buildBridgeSystemPrompt(this.botIdentity));
  }

  async shutdown(): Promise<void> {
    await this.appServer?.shutdown();
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    if (this.appServer) {
      const appServerPrompt = splitBridgePromptForAppServer(opts.prompt);
      return this.appServer.startRun({
        runId: opts.runId,
        // App Server has a real developer-instruction channel. Keep bridge
        // security/identity rules there and pass Feishu history through the
        // protocol's explicitly untrusted context boundary.
        prompt: appServerPrompt.prompt,
        ...(Object.keys(appServerPrompt.additionalContext).length > 0
          ? { additionalContext: appServerPrompt.additionalContext }
          : {}),
        developerInstructions: buildBridgeSystemPrompt(this.botIdentity),
        cwd: opts.cwd,
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.images ? { images: opts.images } : {}),
        sandbox: opts.sandbox ?? this.sandbox,
        ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      });
    }

    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
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
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
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
}

async function verifyAppServerProtocol(binary: string): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), 'lark-channel-codex-schema-'));
  try {
    await runProtocolSchemaProbe(binary, outDir);
    const schema = await readFile(join(outDir, 'v2', 'TurnStartParams.json'), 'utf8');
    if (!schema.includes('additionalContext') || !schema.includes('clientUserMessageId')) {
      throw new Error(
        'configured Codex app-server is incompatible: TurnStartParams must support additionalContext and clientUserMessageId',
      );
    }
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runProtocolSchemaProbe(binary: string, outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(binary, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      outDir,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex app-server protocol probe timed out'));
    }, 10_000);
    child.stderr?.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex app-server protocol probe failed (${signal ?? `code ${code}`})`));
    });
  });
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
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
    yield* translator.fail(`codex runtime error: ${earlyRuntimeError.message}`);
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
      yield* translator.fail(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
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
