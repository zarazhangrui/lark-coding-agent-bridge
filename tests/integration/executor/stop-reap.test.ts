import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import type { RunPolicyAllow } from '../../../src/policy/run-policy.js';

const REAP_MS = 5_000;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Cleanup normally rides on the agent's event stream ending. A child that
 * ignores SIGTERM, a SIGKILL that leaves a descendant holding the pipe, or an
 * adapter generator parked on a promise that never settles all break that
 * assumption — and used to hold the pool slot and the scope reservation for the
 * lifetime of the process. Ten such runs silently wedged every chat.
 */
describe('run executor stop reaper', () => {
  it('releases the pool slot even when the event stream never ends', async () => {
    vi.useFakeTimers();
    const h = harness();

    const execution = await h.executor.submit(submitInput('scope-a'));
    void drain(execution.subscribe());
    expect(h.pool.snapshot().active).toBe(1);

    // The `/stop` path: goes through ActiveRuns, never through
    // `RunExecution.stop`, and the stream stays open regardless.
    h.activeRuns.interrupt('scope-a');
    await vi.advanceTimersByTimeAsync(REAP_MS + 100);

    expect(h.pool.snapshot().active).toBe(0);
    expect(h.agent.lastRun?.stopped).toBe(true);
  });

  it('does not let repeated hangs exhaust the concurrency cap', async () => {
    // The real-world failure: each wedged run permanently burned one of
    // `maxConcurrentRuns`. After that many hangs the bridge went silent for
    // *every* chat, with nothing in the logs pointing at the cap.
    vi.useFakeTimers();
    const h = harness();
    const cap = h.pool.snapshot().cap;

    for (let i = 0; i <= cap; i++) {
      const execution = await h.executor.submit(submitInput(`scope-${i}`));
      void drain(execution.subscribe());
      h.activeRuns.interrupt(`scope-${i}`);
      await vi.advanceTimersByTimeAsync(REAP_MS + 100);
    }

    expect(h.pool.snapshot().active).toBe(0);
    // A fresh run must still be admitted without waiting on a free slot.
    const next = h.pool.tryAcquire();
    expect(next).toBeDefined();
    next?.();
  });

  it('releases subscribers so the reply can still be finalized', async () => {
    vi.useFakeTimers();
    const h = harness();

    const execution = await h.executor.submit(submitInput('scope-a'));
    const drained = drain(execution.subscribe());

    h.activeRuns.interrupt('scope-a');
    await vi.advanceTimersByTimeAsync(REAP_MS + 100);

    // The consumer must come back, not stay parked on a dead stream — that
    // consumer is what renders the terminal card.
    await expect(drained).resolves.toBeInstanceOf(Array);
  });

  it('tears the event source down, not just the subscribers', async () => {
    // Waking subscribers alone leaves `pump()` parked on `source.next()`,
    // still holding the run's iterator and the child's stdout — and, if the
    // child ignored SIGTERM, leaves it running as an orphan.
    vi.useFakeTimers();
    const h = harness();

    const execution = await h.executor.submit(submitInput('scope-a'));
    void drain(execution.subscribe());
    h.activeRuns.interrupt('scope-a');
    expect(h.agent.lastRun?.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(REAP_MS + 100);

    expect(h.agent.lastRun?.destroyed).toBe(true);
    // Give the released generator a turn to run its `finally`.
    await vi.advanceTimersByTimeAsync(10);
    expect(h.agent.lastRun?.sourceEnded).toBe(true);
  });

  it('does not reap a healthy run that ends on its own', async () => {
    vi.useFakeTimers();
    const h = harness({ events: [{ type: 'done', terminationReason: 'normal' }] });

    const execution = await h.executor.submit(submitInput('scope-a'));
    const events = await drain(execution.subscribe());
    await vi.advanceTimersByTimeAsync(REAP_MS * 3);

    expect(events.map((e) => e.type)).toContain('done');
    expect(h.pool.snapshot().active).toBe(0);
    // Nothing was force-stopped; the run simply finished.
    expect(h.agent.lastRun?.stopped).toBe(false);
  });

  it('leaves no reaper pending after an explicit execution stop', async () => {
    vi.useFakeTimers();
    const h = harness();

    const execution = await h.executor.submit(submitInput('scope-a'));
    void drain(execution.subscribe());
    await execution.stop();

    expect(h.pool.snapshot().active).toBe(0);
    // A second pass of the clock must not double-release and drive the
    // pool's active count negative or wake a stale waiter.
    await vi.advanceTimersByTimeAsync(REAP_MS * 3);
    expect(h.pool.snapshot().active).toBe(0);
  });
});

function harness(options: { events?: AgentEvent[] } = {}): {
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
  agent: StallingAgent;
} {
  const pool = new ProcessPool(() => 2);
  const activeRuns = new ActiveRuns();
  const agent = new StallingAgent(options.events ?? []);
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    stopReapGraceMs: REAP_MS,
    postDoneExitGraceMs: 10,
  });
  return { pool, activeRuns, executor, agent };
}

/**
 * Emits the configured events, then holds the stream open forever — `stop()`
 * deliberately does *not* end it, which is the whole scenario under test.
 */
class StallingAgent implements AgentAdapter {
  readonly id = 'stalling';
  readonly displayName = 'Stalling Agent';
  lastRun: { stopped: boolean; destroyed: boolean; sourceEnded: boolean } | undefined;
  #events: AgentEvent[];

  constructor(events: AgentEvent[]) {
    this.#events = events;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(): void {}

  run(opts: AgentRunOptions): AgentRun {
    const events = [...this.#events];
    const state = { stopped: false, destroyed: false, sourceEnded: false };
    this.lastRun = state;
    const ends = events.some((e) => e.type === 'done' || e.type === 'error');
    // Resolves only when `destroy()` tears the source down — the stand-in for
    // a child that ignored SIGTERM and left stdout held open by a descendant.
    let releaseSource: (() => void) | undefined;
    return {
      runId: opts.runId,
      events: (async function* (): AsyncGenerator<AgentEvent> {
        try {
          for (const evt of events) yield evt;
          if (ends) return;
          await new Promise<void>((resolve) => {
            releaseSource = resolve;
          });
        } finally {
          state.sourceEnded = true;
        }
      })(),
      async stop() {
        // Deliberately does NOT end the stream: `stop()` being insufficient is
        // the whole scenario the reaper exists for.
        state.stopped = true;
      },
      destroy() {
        state.destroyed = true;
        releaseSource?.();
      },
      async waitForExit() {
        return ends;
      },
    };
  }
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const evt of events) seen.push(evt);
  return seen;
}

function submitInput(scopeId: string): {
  scopeId: string;
  policy: RunPolicyAllow;
} {
  return {
    scopeId,
    policy: {
      prompt: 'hi',
      cwdRealpath: '/tmp',
      expiresAt: Date.now() + 600_000,
      accessMode: 'full',
      sandbox: 'danger-full-access',
      permissionMode: 'bypassPermissions',
    } as unknown as RunPolicyAllow,
  };
}
