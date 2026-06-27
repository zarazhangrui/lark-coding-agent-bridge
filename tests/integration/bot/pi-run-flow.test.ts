import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { piCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('pi run flow', () => {
  it('resumes a pi session by sessionId (session-based, like claude)', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: piCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('rejects a missing cwd for pi the same way as claude', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: piCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: { code: 'empty-requested-cwd' },
    });
    expect(h.agent.runOptions).toEqual([]);
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-pi-run-flow-');
  const agent = new FakeAgentAdapter({
    id: 'pi',
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'pi',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    pi: { binaryPath: '/usr/local/bin/pi' },
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, agent, executor, sessions, workspaces, profileConfig };
}
