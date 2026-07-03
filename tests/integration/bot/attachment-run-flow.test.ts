import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexCapability, piCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('attachment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('passes accepted image attachment paths to Codex adapter image args only', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: ['/media/image.png'],
    });
  });

  it('includes accepted image attachment paths for a Pi capability, same as codex', async () => {
    const h = await createHarness('pi');

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
      capability: piCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: ['/media/image.png'],
    });
  });
});

async function createHarness(agentKind: 'codex' | 'pi' = 'codex'): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('attachment-run-flow-');
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind === 'codex' ? 'Codex' : 'Pi',
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
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex' } }
      : { pi: { binaryPath: '/usr/local/bin/pi' } }),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}
