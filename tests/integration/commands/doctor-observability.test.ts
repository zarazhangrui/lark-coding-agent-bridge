import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('/doctor run observability', () => {
  it('submits the agent echo check with doctor source and agent-probe stage', async () => {
    const h = await createHarness();

    await expect(h.run('/doctor')).resolves.toBe(true);
    await flushLogger();

    const started = (await readLogLines(h.logsDir)).find(
      (line) => line.phase === 'run' && line.event === 'started',
    );
    expect(started).toMatchObject({
      profile: 'claude',
      agent: 'claude',
      source: 'doctor',
      stage: 'agent-probe',
    });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  logsDir: string;
  run(content: string): Promise<boolean>;
}> {
  const tmp = await createTmpProfile('doctor-observability-');
  const logsDir = join(tmp.profile, 'logs');
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 1,
  });

  return {
    tmp,
    logsDir,
    run: (content: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        processPool: pool,
        runExecutor: executor,
        controls,
      }),
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

async function readLogLines(logsDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
