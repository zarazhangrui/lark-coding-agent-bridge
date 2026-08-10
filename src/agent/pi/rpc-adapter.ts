import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
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
import { RpcConnection } from './rpc-connection';

/**
 * PiRpcAdapter — pi agent backed by a persistent `pi --mode rpc` process.
 *
 * Unlike {@link PiAdapter} (spawn-per-run with `--mode json`), this adapter
 * maintains a **pool of persistent RPC processes** keyed by sessionId. Each
 * process survives across turns (up to 24h TTL), giving:
 *
 * - **Fast turn-around**: no pi startup cost after the first message.
 * - **Steer**: a running turn can be redirected mid-flight via `{type:"steer"}`.
 * - **Session resume**: if a process dies, the next run spawns a fresh one
 *   with `--session <id>`, resuming from pi's persisted session file — the
 *   same mechanism as omp `-c`.
 *
 * Pool lifecycle:
 - `run()`: find connection by sessionId (or spawn new) → prompt → events
 - After agent_end: connection **stays alive** in the pool (not disposed)
 - `stop()`: send `{type:"abort"}` (graceful flush, not SIGTERM)
 - `steer()`: send `{type:"steer"}` (inject mid-turn)
 - `waitForExit()`: resolves immediately on agent_end event — the process
 *   persists, so there's nothing to wait for.
 - 24h TTL sweep: idle connections older than 24h are disposed.
 - SIGTERM: all connections killed.
 *
 * Concurrency: each scope (chat) gets its own connection (keyed by sessionId).
 * ActiveRuns already prevents concurrent runs within a scope, so no two
 * prompts hit the same RPC process simultaneously.
 *
 * Protocol verified against:
 *   pi-coding-agent/dist/modes/rpc/rpc-mode.js (handleCommand, handleInputLine)
 *   pi-coding-agent/dist/modes/rpc/jsonl.js (strict LF framing)
 *   pi-coding-agent/dist/modes/json-event.js (toJsonEvent passthrough)
 */

export interface PiRpcAdapterOptions {
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
  /** Grace period for abort → dispose. */
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** Connection pool TTL in ms (default 24h). Idle connections older than this are swept. */
  poolTtlMs?: number;
}

interface PooledConnection {
  conn: RpcConnection;
  lastUsed: number;
}

export class PiRpcAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'pi coding agent (RPC)';

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

  // ── persistent connection pool ──────────────────────────────────
  /** Keyed by sessionId. Each scope (chat) maps to one pi session. */
  private readonly pool = new Map<string, PooledConnection>();
  private readonly poolTtlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private shutdownHandlersBound = false;

  constructor(opts: PiRpcAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.model = opts.model;
    this.piAgentDir = opts.piAgentDir;
    this.inheritPiAgentDir = opts.inheritPiAgentDir !== false;
    this.gatewayBaseUrl = opts.gatewayBaseUrl;
    this.gatewayApiKeyEnv = opts.gatewayApiKeyEnv;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.poolTtlMs = opts.poolTtlMs ?? 24 * 60 * 60 * 1000; // 24h default

    // Sweep stale connections every 10 minutes. unref so it doesn't keep
    // the event loop alive on shutdown.
    this.sweepTimer = setInterval(() => this.sweepPool(), 10 * 60 * 1000);
    this.sweepTimer.unref?.();
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
    if (this.piAgentDir || !this.inheritPiAgentDir) {
      const dir = this.piAgentDir ?? join(this.profileStateDir, 'pi-agent');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (this.gatewayBaseUrl) {
        await writeModelsJson(dir, this.gatewayBaseUrl, this.gatewayApiKeyEnv);
      }
    }
    // Bind SIGTERM/SIGINT once to kill all pooled processes on shutdown.
    // Deferred to prepareRun (not constructor) so it only fires for the
    // active adapter, not short-lived doctor/probe instances.
    if (!this.shutdownHandlersBound) {
      this.shutdownHandlersBound = true;
      process.once('SIGTERM', () => this.disposeAll());
      process.once('SIGINT', () => this.disposeAll());
    }
  }

  // ── pool management ─────────────────────────────────────────────

  private acquire(opts: AgentRunOptions): RpcConnection {
    // Reuse existing connection for this session, or spawn new.
    if (opts.sessionId) {
      const entry = this.pool.get(opts.sessionId);
      if (entry && entry.conn.alive) {
        entry.lastUsed = Date.now();
        log.info('pi-rpc', 'pool-reuse', {
          sessionId: opts.sessionId,
          pid: entry.conn.pid ?? null,
        });
        return entry.conn;
      }
      // Stale entry — clean up.
      if (entry) this.pool.delete(opts.sessionId);
    }

    // Spawn new connection. When sessionId is provided, --session resumes
    // from pi's persisted session file (same as omp -c).
    const conn = this.spawnConnection(opts);
    return conn;
  }

  /** Store a connection in the pool once we know its sessionId. */
  private store(sessionId: string, conn: RpcConnection): void {
    // If an old connection exists for this session, dispose it first.
    const old = this.pool.get(sessionId);
    if (old && old.conn !== conn) {
      void old.conn.dispose(this.defaultStopGraceMs).catch(() => {});
    }
    this.pool.set(sessionId, { conn, lastUsed: Date.now() });
  }

  private spawnConnection(opts: AgentRunOptions): RpcConnection {
    const args = this.buildArgs(opts);
    const envOverrides = buildLarkChannelEnv(this.larkChannel);
    if (this.piAgentDir) {
      envOverrides.PI_CODING_AGENT_DIR = this.piAgentDir;
    } else if (!this.inheritPiAgentDir) {
      envOverrides.PI_CODING_AGENT_DIR = join(this.profileStateDir, 'pi-agent');
    }

    const conn = new RpcConnection({
      binary: this.binary,
      args,
      env: envOverrides,
      cwd: opts.cwd!,
    });

    log.info('agent', 'rpc-spawn', {
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model ?? this.model,
    });

    // For known sessions, store immediately. For new sessions, store
    // after the session event arrives (handled in run()).
    if (opts.sessionId) {
      this.store(opts.sessionId, conn);
    }

    return conn;
  }

  /** Periodic sweep: dispose connections idle longer than TTL. */
  private sweepPool(): void {
    const now = Date.now();
    let swept = 0;
    for (const [sessionId, entry] of this.pool) {
      if (!entry.conn.alive || now - entry.lastUsed > this.poolTtlMs) {
        void entry.conn.dispose(this.defaultStopGraceMs).catch(() => {});
        this.pool.delete(sessionId);
        swept++;
      }
    }
    if (swept > 0) {
      log.info('pi-rpc', 'pool-swept', { swept, remaining: this.pool.size });
    }
  }

  /** Kill all pooled connections (SIGTERM/SIGINT shutdown). */
  private disposeAll(): void {
    log.info('pi-rpc', 'pool-dispose-all', { poolSize: this.pool.size });
    clearInterval(this.sweepTimer);
    for (const [, entry] of this.pool) {
      entry.conn.kill();
    }
    this.pool.clear();
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiRpcAdapter.run');
    }

    const conn = this.acquire(opts);
    let stopReason: PiFinishReason | undefined;

    // turnEnded resolves when the event stream ends. waitForExit races
    // this against a timeout — but since the connection persists, a
    // resolved turnEnded means "done" immediately (no process exit).
    let turnEndedResolve!: () => void;
    const turnEnded = new Promise<void>((resolve) => {
      turnEndedResolve = resolve;
    });

    const self = this;
    const eventStream = (async function* (): AsyncGenerator<AgentEvent> {
      const translator = new PiJsonTranslator();

      // Send the prompt. Response resolves on preflight success, not
      // turn end. Turn events flow through conn.events().
      try {
        await conn.prompt(opts.prompt, opts.images);
      } catch (err) {
        turnEndedResolve();
        yield {
          type: 'error',
          message: `pi RPC prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          terminationReason: 'failed',
        };
        return;
      }

      // RPC mode does NOT emit a `session` header event (unlike --mode json).
      // The sessionId is only available via get_state. Fetch it once after
      // the first prompt, synthesize a `system` event so bridge session
      // tracking (recordRunSessionEvent) works, and store the connection
      // in the pool for future reuse.
      if (!opts.sessionId) {
        try {
          const state = await conn.send<{ sessionId?: string }>(
            { type: 'get_state' },
            5000,
          );
          if (state?.sessionId) {
            self.store(state.sessionId, conn);
            // Synthesize the system event the bridge expects.
            yield {
              type: 'system',
              sessionId: state.sessionId,
              cwd: opts.cwd,
            };
          }
        } catch {
          // get_state failed — non-fatal, session just won't be tracked.
        }
      }

      // Consume AgentSessionEvents until terminal or connection death.
      try {
        for await (const ev of conn.events()) {
          const agentEvents = translator.translate(ev);
          for (const ae of agentEvents) {
            // CRITICAL: resolve turnEnded BEFORE yielding terminal events.
            // The consumer (EventFanout.pump) breaks on done/error, which
            // suspends this generator at the yield. If turnEndedResolve
            // were after the yield, it would never execute.
            if (ae.type === 'done' || ae.type === 'error') {
              turnEndedResolve();
            }
            yield ae;
          }
          if (translator.terminalEmitted()) {
            return;
          }
        }
      } catch {
        // fall through to finish
      }

      // Connection ended without agent_end — synthesize terminal event.
      const reason = stopReason ?? 'failed';
      const finishEvents = translator.finish(reason);
      for (const ae of finishEvents) {
        turnEndedResolve();
        yield ae;
      }
    })();

    return {
      runId: opts.runId,
      events: eventStream,
      async stop() {
        stopReason = 'interrupted';
        log.info('agent', 'rpc-abort', {});
        await conn.abort().catch((err) => {
          log.warn('agent', 'rpc-abort-failed', { err: String(err) });
        });
      },
      async steer(message: string) {
        await conn.steer(message);
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        // The connection persists — we only need the turn to end, not
        // the process to exit. turnEnded resolves before the terminal
        // event is yielded, so this is near-instant on normal completion.
        const settled = await Promise.race([
          turnEnded.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        log.info('pi-rpc', 'wait-for-exit', { settled, timeoutMs });
        return settled;
      },
    };
  }

  /**
   * Build `pi --mode rpc` CLI args.
   *
   * The prompt is NOT passed as a CLI arg (unlike spawn mode's `-p`); it's
   * sent as a `{type:"prompt"}` command after the process starts. Session
   * resume, model, and system prompt are CLI args processed by main.js
   * before entering RPC mode.
   */
  private buildArgs(opts: AgentRunOptions): string[] {
    const args = [
      '--mode',
      'rpc',
      '--append-system-prompt',
      buildBridgeSystemPrompt(this.botIdentity),
    ];
    if (opts.sessionId) {
      args.push('--session', opts.sessionId);
    }
    const model = opts.model ?? this.model;
    if (model) args.push('--model', model);
    return args;
  }
}

/**
 * Write a models.json custom-provider override into the isolated pi config dir.
 * Duplicated from adapter.ts to avoid cross-file coupling for a static helper.
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
