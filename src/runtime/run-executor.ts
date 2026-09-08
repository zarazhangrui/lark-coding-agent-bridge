import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  stopReapGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  effort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;
/**
 * How long after a stop request the executor waits for the event stream to end
 * on its own before releasing the run's resources regardless.
 *
 * Cleanup normally rides on the source iterable finishing, which is fine while
 * the child cooperates: SIGTERM closes its stdout, the stream ends, the slot is
 * released. It is not fine when the child ignores SIGTERM, when SIGKILL leaves
 * a descendant holding the pipe, or when the adapter's generator is parked on a
 * promise that never settles. In those cases the pool slot and the scope
 * reservation were held for the lifetime of the process — every such run
 * permanently burned one of `maxConcurrentRuns` (10 by default), so ten hangs
 * silently wedged every chat on the bridge with no error anywhere.
 */
const DEFAULT_STOP_REAP_GRACE_MS = 30_000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly stopReapGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.stopReapGraceMs = deps.stopReapGraceMs ?? DEFAULT_STOP_REAP_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      effort: input.effort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    // Every stop path has to arm the reaper, not just `RunExecution.stop`.
    // `ActiveRuns.interrupt` (the `/stop` command) and `ActiveRuns.stopAll`
    // (shutdown) call `handle.run.stop()` straight through, and the stall
    // watchdog does the same — all of them drop the handle without ever
    // releasing the pool slot. Wrapping the run here is what makes the
    // guarantee hold no matter who asks for the stop.
    let armReaper = (): void => {};
    const guardedStop = async (): Promise<void> => {
      armReaper();
      await run.stop();
    };
    // A Proxy rather than a spread: adapters expose `stopped` / `waitForExit`
    // as prototype getters and methods over private fields, and a spread would
    // both drop the getters and rebind `this` away from the instance.
    const guardedRun: AgentRun = new Proxy(run, {
      get(target, prop, _receiver) {
        if (prop === 'stop') return guardedStop;
        // Receiver is the target, not the proxy, so prototype getters and
        // bound methods keep reaching their own private fields.
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, guardedRun);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    let reaper: ReturnType<typeof setTimeout> | undefined;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (reaper) clearTimeout(reaper);
      reaper = undefined;
      // Must unregister the same object that was registered, or the identity
      // check in `ActiveRuns.unregister` silently keeps the scope occupied.
      this.activeRuns.unregister(input.scopeId, guardedRun);
      release();
      if (waitForExit) {
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions,
            graceMs: this.postDoneExitGraceMs,
          });
          await run.stop().catch((err) => {
            log.warn('run', 'post-done-stop-failed', {
              ...dimensions,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(!handle.interrupted);
    });

    armReaper = (): void => {
      if (cleaned || reaper) return;
      reaper = setTimeout(() => {
        if (cleaned) return;
        log.warn('run', 'stop-reap', {
          ...dimensions,
          graceMs: this.stopReapGraceMs,
          reason: 'event stream did not end after stop; releasing resources anyway',
        });
        // Release the subscribers. Without this, a caller awaiting the stream
        // — `processAgentStream`, and therefore the reply that tells the user
        // anything at all — stays parked on a source that will never produce
        // again, and the card is never finalized.
        fanout.forceFinish();
        // Then tear the source down for real. Waking subscribers alone leaves
        // `pump()` parked on `source.next()`, still holding the run's event
        // iterator and the child's stdout — and, if the child ignored the
        // earlier SIGTERM, leaves it running as an orphan. `destroy()`
        // SIGKILLs and closes the pipes so the iterator actually ends.
        try {
          run.destroy?.();
        } catch (err) {
          log.warn('run', 'stop-reap-destroy-failed', {
            ...dimensions,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        void cleanup(false);
      }, this.stopReapGraceMs);
      // A pending reaper must never be the reason the process stays alive.
      reaper.unref?.();
    };

    return {
      runId,
      scopeId: input.scopeId,
      run: guardedRun,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await guardedRun.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        // The explicit path still cleans up inline — the reaper armed by
        // `guardedRun.stop` is only the backstop for stops that come in
        // through `ActiveRuns` and never reach this method.
        await cleanup(false);
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /**
   * Release every subscriber without waiting on the source.
   *
   * The pump itself stays parked on a source that will never yield again —
   * there is no portable way to cancel an async iterator mid-`next()` — but it
   * holds nothing but itself once `onDone` has run. What matters is that
   * consumers stop waiting on a dead stream and can finalize their output.
   */
  forceFinish(): void {
    if (this.done) return;
    this.done = true;
    this.wakeAll();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
