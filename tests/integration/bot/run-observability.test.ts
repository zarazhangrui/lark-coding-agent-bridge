import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { startRunFlow } from '../../../src/bot/run-flow';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bot run observability', () => {
  it('keeps IM run submit logs populated with profile, source, and stage', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      userInput: { kind: 'unavailable', reason: 'caller-does-not-support-interactive-turns' },
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1_700_000_000_000,
      observability: {
        profile: 'claude',
        agent: 'claude',
        source: 'im',
        stage: 'submit',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    await collect(result.execution.subscribe());
    await flushLogger();

    const started = (await readLogLines(h.logsDir)).find(
      (line) => line.phase === 'run' && line.event === 'started',
    );
    expect(started).toMatchObject({
      profile: 'claude',
      agent: 'claude',
      source: 'im',
      stage: 'submit',
    });
    expect(JSON.stringify(started)).not.toContain('unknown');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  logsDir: string;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-run-observability-');
  const logsDir = join(tmp.profile, 'logs');
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 1,
  });
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const profileConfig = {
    ...base,
    workspaces: {
      ...base.workspaces,
      default: tmp.workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    logsDir,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig,
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
