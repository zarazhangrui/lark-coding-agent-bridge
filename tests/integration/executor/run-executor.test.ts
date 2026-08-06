import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { RunRejected, SpawnFailed } from '../../../src/runtime/errors';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';
import {
  FakeAgentAdapter,
  type FakeAgentEvents,
  type FakeAgentRun,
} from '../../helpers/fake-agent';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RunExecutor', () => {
  it('generates one runId and wires it through adapter, record, and active runs', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
      stopGraceMs: 123,
    });

    expect(execution.runId).toBe('run-1');
    expect(execution.run.runId).toBe('run-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      prompt: 'hello',
      cwd: h.tmp.workspace,
      stopGraceMs: 123,
    });
    expect(h.activeRuns.get('scope-1')?.run.runId).toBe('run-1');

    await collect(execution.subscribe());
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('fans out one agent event stream to multiple consumers without spawning twice', async () => {
    const events = [
      { type: 'system' as const, sessionId: 'sess-1', cwd: '/repo' },
      { type: 'text' as const, delta: 'hello' },
      { type: 'done' as const, sessionId: 'sess-1', terminationReason: 'normal' as const },
    ];
    const h = await createHarness({ events });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    const [rendererEvents, sessionEvents] = await Promise.all([
      collect(execution.subscribe()),
      collect(execution.subscribe()),
    ]);

    expect(h.agent.runs).toHaveLength(1);
    expect(rendererEvents).toEqual(events);
    expect(sessionEvents).toEqual(events);
  });

  it('fast-fails nowait when the pool is full and queues normal submissions FIFO', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-nowait',
        policy: policy(h.tmp.workspace),
        nowait: true,
      }),
    ).rejects.toMatchObject({ code: 'pool-full' });

    const secondPromise = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    await collect(first.subscribe());
    const second = await secondPromise;
    expect(second.runId).toBe('run-2');
    await collect(second.subscribe());
  });

  it('rejects expired policy before spawning the adapter', async () => {
    const h = await createHarness({ events: [] });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace, { expiresAt: 999 }),
      }),
    ).rejects.toBeInstanceOf(RunRejected);
    expect(h.agent.runs).toHaveLength(0);
  });

  it('rejects new submissions while reconnect is draining active runs', async () => {
    const h = await createHarness({ events: [] });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('with reconnectWaitMs configured, holds a submission until a short reconnect clears and then runs it', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
      reconnectWaitMs: 5000,
    });
    const resume = h.activeRuns.pauseNewRuns('reconnect');

    const submitPromise = h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    // Give submit() a tick to hit the paused check and start waiting.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.agent.runs).toHaveLength(0);

    resume();

    const execution = await submitPromise;
    expect(execution.runId).toBe('run-1');
    expect(h.agent.runs).toHaveLength(1);
    await collect(execution.subscribe());
  });

  it('with reconnectWaitMs configured, still rejects once the wait window elapses without a resume', async () => {
    const h = await createHarness({ events: [], reconnectWaitMs: 20 });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(0);
    } finally {
      resume();
    }
  });

  it('with reconnectWaitMs configured, nowait submissions still fail fast instead of waiting', async () => {
    const h = await createHarness({ events: [], reconnectWaitMs: 5000 });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      const start = Date.now();
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
          nowait: true,
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      resume();
    }
  });

  it('without reconnectWaitMs configured, keeps the original immediate-reject behavior', async () => {
    const h = await createHarness({ events: [] });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      const start = Date.now();
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      resume();
    }
  });

  it('rejects duplicate submissions for a scope that already has a run', async () => {
    const h = await createHarness({ events: [{ type: 'done', terminationReason: 'normal' }] });

    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toMatchObject({ code: 'run-already-active' });
    expect(h.agent.runs).toHaveLength(1);

    await collect(first.subscribe());
  });

  it('accepts new submissions after reconnect drain is released', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    resume();

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    expect(execution.runId).toBe('run-1');
    await collect(execution.subscribe());
  });

  it('rejects submissions that were queued before reconnect drain started', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    const second = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await collect(first.subscribe());
      await expect(second).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(1);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('rejects submissions paused while prepareRun is still pending', async () => {
    const agent = new DelayedPrepareAgent({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const h = await createHarness({ agent });

    const submit = h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    await agent.prepareStarted;

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      agent.releasePrepare();
      await expect(submit).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('releases pool and active run state when adapter spawn fails', async () => {
    const h = await createHarness({ agent: new ThrowingAgent() });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toBeInstanceOf(SpawnFailed);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('stops and waits for the underlying run when execution is interrupted', async () => {
    const h = await createHarness({
      events: [{ type: 'text', delta: 'running' }],
      waitForExit: true,
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await execution.stop();

    const run = execution.run as FakeAgentRun;
    expect(run.stopped).toBe(true);
    expect(run.waitForExitCalls).toBe(1);
  });

  it('stops the underlying process when it does not exit after a terminal event', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
      waitForExit: false,
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await collect(execution.subscribe());

    const run = execution.run as FakeAgentRun;
    expect(run.waitForExitCalls).toBe(1);
    expect(run.stopped).toBe(true);
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });
});

async function createHarness(options: {
  events?: FakeAgentEvents;
  waitForExit?: boolean | readonly boolean[];
  poolCap?: number;
  agent?: AgentAdapter;
  reconnectWaitMs?: number;
}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
}> {
  const tmp = await createTmpProfile('bridge-executor-');
  cleanups.push(tmp.cleanup);
  let nextRun = 1;
  const agent =
    options.agent ??
    new FakeAgentAdapter({
      events: options.events ?? [],
      waitForExit: options.waitForExit,
    });
  const pool = new ProcessPool(() => options.poolCap ?? 2);
  const activeRuns = new ActiveRuns();
  return {
    tmp,
    agent: agent as FakeAgentAdapter,
    pool,
    activeRuns,
    executor: new RunExecutor({
      agent,
      pool,
      activeRuns,
      createRunId: () => `run-${nextRun++}`,
      now: () => 1000,
      postDoneExitGraceMs: 10,
      reconnectWaitMs: options.reconnectWaitMs,
    }),
  };
}

function policy(cwd: string, overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: cwd,
    cwdRealpath: cwd,
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

class ThrowingAgent implements AgentAdapter {
  readonly id = 'throwing';
  readonly displayName = 'Throwing';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(_opts: AgentRunOptions): AgentRun {
    throw new Error('spawn failed');
  }
}

class DelayedPrepareAgent extends FakeAgentAdapter {
  readonly prepareStarted: Promise<void>;
  private resolvePrepareStarted!: () => void;
  private resolvePrepare!: () => void;

  constructor(options: ConstructorParameters<typeof FakeAgentAdapter>[0]) {
    super(options);
    this.prepareStarted = new Promise((resolve) => {
      this.resolvePrepareStarted = resolve;
    });
  }

  async prepareRun(): Promise<void> {
    this.resolvePrepareStarted();
    await new Promise<void>((resolve) => {
      this.resolvePrepare = resolve;
    });
  }

  releasePrepare(): void {
    this.resolvePrepare();
  }
}
