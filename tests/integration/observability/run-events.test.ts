import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger.js';
import type { RunPolicyAllow } from '../../../src/policy/run-policy.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('run observability events', () => {
  afterEach(async () => {
    await closeLogger();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records run started and completed events with low-sensitivity dimensions', async () => {
    const h = await createHarness();

    const execution = await h.executor.submit({
      scopeId: 'chat-1',
      userInput: { kind: 'unavailable', reason: 'caller-does-not-support-interactive-turns' },
      policy: policy(h.tmp.workspace),
      observability: {
        profile: 'claude',
        agent: 'claude',
        source: 'im',
        stage: 'submit',
      },
    });
    await collect(execution.subscribe());
    await flushLogger();

    const lines = (await readLogLines(h.logsDir)).filter((line) => line.phase === 'run');
    expect(lines.map((line) => `${line.phase}.${line.event}`)).toEqual([
      'run.started',
      'run.completed',
    ]);
    expect(lines[0]).toMatchObject({
      runId: 'run-1',
      profile: 'claude',
      agent: 'claude',
      scope: 'chat-1',
      source: 'im',
      stage: 'submit',
      queueWaitMs: 0,
    });
    expect(lines[1]).toMatchObject({
      runId: 'run-1',
      result: 'normal',
      durationMs: 0,
    });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  logsDir: string;
  executor: RunExecutor;
}> {
  const tmp = await createTmpProfile('run-events-');
  cleanups.push(tmp.cleanup);
  const logsDir = join(tmp.profile, 'logs');
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 1,
  });
  return { tmp, logsDir, executor };
}

function policy(cwd: string): RunPolicyAllow {
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
    expiresAt: 2_000_000_000_000,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function readLogLines(logsDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
