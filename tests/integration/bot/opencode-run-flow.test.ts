import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { opencodeCapability } from '../../../src/agent/capability';
import { OpencodeAdapter } from '../../../src/agent/opencode/adapter';
import { buildOpencodeArgs } from '../../../src/agent/opencode/argv.js';
import type { AgentEvent } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { recordRunSessionEvent, startRunFlow } from '../../../src/bot/run-flow';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createTmpProfile } from '../../helpers/tmp-profile';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('OpenCode run flow (end-to-end with fake binary)', () => {
  it('spawns opencode via RunExecutor/startRunFlow, emits expected events, and records catalog entry', async () => {
    const tmp = await createTmpProfile('bridge-opencode-run-flow-');

    const workspaceRealpath = await realpath(tmp.workspace);

    // Build a fake opencode binary that emits a single text event then exits cleanly.
    const sessionId = 'sess-e2e-001';
    const fake = await createFakeOpencode({
      lines: [
        {
          type: 'text',
          timestamp: 1,
          sessionID: sessionId,
          part: { type: 'text', text: 'hello from opencode', time: { end: 2 } },
        },
      ],
    });

    const baseProfileConfig = createDefaultProfileConfig({
      agentKind: 'opencode',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
      opencode: { binaryPath: fake.path },
      permissions: { defaultAccess: 'read-only', maxAccess: 'full' },
    });
    const profileConfig = {
      ...baseProfileConfig,
      workspaces: { ...baseProfileConfig.workspaces, default: tmp.workspace },
    };

    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const catalogPath = join(tmp.profile, 'sessions.catalog.json');
    const sessionCatalog = new SessionCatalog(catalogPath);
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));

    const agent = new OpencodeAdapter({
      binary: fake.path,
      profileStateDir: tmp.profile,
      access: 'read-only',
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-1',
      now: () => 1000,
      postDoneExitGraceMs: 100,
    });

    // Register cleanups in reverse-dependency order: flush stores first, then remove dirs.
    cleanups.push(async () => {
      await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    });
    cleanups.push(() => rm(fake.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
    cleanups.push(tmp.cleanup);

    const capability = opencodeCapability(profileConfig);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello from lark',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability,
      profileConfig,
      sessions,
      sessionCatalog,
      workspaces,
      executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    // Fresh run — no resume.
    expect(result.resumeFrom).toBeUndefined();

    // Collect all events from the real adapter stream.
    const events: AgentEvent[] = [];
    for await (const evt of result.execution.subscribe()) {
      events.push(evt);
      // Feed each system event into recordRunSessionEvent (same as channel.ts does).
      recordRunSessionEvent({
        scopeId: 'chat-1',
        sessions,
        sessionCatalog,
        capability,
        policy: result.policy,
        event: evt,
      });
    }

    // Assert event sequence: system(sessionId) → final_text → done(normal).
    expect(events).toEqual([
      { type: 'system', sessionId },
      { type: 'final_text', content: 'hello from opencode' },
      { type: 'done', sessionId, terminationReason: 'normal' },
    ]);

    // Assert SessionStore got the opencode sessionId recorded.
    const storedSession = sessions.getRaw('chat-1');
    expect(storedSession).toBeDefined();
    expect(storedSession?.sessionId).toBe(sessionId);
    expect(storedSession?.cwd).toBe(workspaceRealpath);

    // Flush pending async persists before cleanup runs so scheduled writes don't race dir removal.
    await sessions.flush();
    await sessionCatalog.flush();

    // Assert catalog entry was written for opencode.
    const entries = sessionCatalog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentId: 'opencode',
      scopeId: 'chat-1',
      cwdRealpath: workspaceRealpath,
      sessionId,
      status: 'active',
    });
    expect(entries[0]?.threadId).toBeUndefined();

    // Assert fake binary received correct argv and stdin.
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildOpencodeArgs({ cwd: workspaceRealpath, access: 'read-only', prompt: 'hello from lark' }),
    );
    expect(record.argv).toContain('--format');
    expect(record.argv).toContain('json');
    expect(record.argv).toContain('--agent');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('plan');
    expect(record.argv).not.toContain('--auto'); // read-only → no --auto
    // Prompt must NOT be in argv (delivered via stdin for Windows safety).
    expect(record.argv).not.toContain('hello from lark');
    // Stdin must contain both the bridge system prompt prefix and the user prompt.
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
  });

  it('uses --agent build + --auto for full-access opencode runs, and resumes prior sessionId on second run', async () => {
    const tmp = await createTmpProfile('bridge-opencode-resume-');

    const workspaceRealpath = await realpath(tmp.workspace);

    // First run: fresh, emits sessionId sess-a.
    const firstSessionId = 'sess-a';
    const fake1 = await createFakeOpencode({
      lines: [
        {
          type: 'text',
          timestamp: 1,
          sessionID: firstSessionId,
          part: { type: 'text', text: 'first reply', time: { end: 2 } },
        },
      ],
    });

    const baseProfileConfig = createDefaultProfileConfig({
      agentKind: 'opencode',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      opencode: { binaryPath: fake1.path },
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });
    const profileConfig = {
      ...baseProfileConfig,
      workspaces: { ...baseProfileConfig.workspaces, default: tmp.workspace },
    };

    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const catalogPath = join(tmp.profile, 'sessions.catalog.json');
    const sessionCatalog = new SessionCatalog(catalogPath);
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));

    const makeExecutor = (binary: string) => {
      const agent = new OpencodeAdapter({
        binary,
        profileStateDir: tmp.profile,
        access: 'full',
      });
      return new RunExecutor({
        agent,
        pool: new ProcessPool(() => 1),
        activeRuns: new ActiveRuns(),
        createRunId: () => 'run-1',
        now: () => 1000,
        postDoneExitGraceMs: 100,
      });
    };

    const capability = opencodeCapability(profileConfig);

    // Register cleanups in reverse-dependency order: flush first, then dirs.
    cleanups.push(async () => {
      await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    });
    cleanups.push(() => rm(fake1.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));

    // --- First run ---
    const result1 = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'first message',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability,
      profileConfig,
      sessions,
      sessionCatalog,
      workspaces,
      executor: makeExecutor(fake1.path),
      now: 1000,
    });
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error('first run failed to start');

    const events1: AgentEvent[] = [];
    for await (const evt of result1.execution.subscribe()) {
      events1.push(evt);
      recordRunSessionEvent({
        scopeId: 'chat-1',
        sessions,
        sessionCatalog,
        capability,
        policy: result1.policy,
        event: evt,
      });
    }
    expect(events1).toEqual([
      { type: 'system', sessionId: firstSessionId },
      { type: 'final_text', content: 'first reply' },
      { type: 'done', sessionId: firstSessionId, terminationReason: 'normal' },
    ]);

    const rec1 = await readRecord(fake1.recordPath);
    expect(rec1.argv).toContain('--auto');
    expect(rec1.argv[rec1.argv.indexOf('--agent') + 1]).toBe('build');
    // Fresh run: no --session flag.
    expect(rec1.argv).not.toContain('--session');

    // --- Second run: same scope/cwd should resume sess-a via --session ---
    const secondSessionId = 'sess-b';
    const fake2 = await createFakeOpencode({
      lines: [
        {
          type: 'text',
          timestamp: 1,
          sessionID: secondSessionId,
          part: { type: 'text', text: 'second reply', time: { end: 2 } },
        },
      ],
    });
    cleanups.push(() => rm(fake2.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));

    // Update profileConfig binary path to point at fake2 (simulating a new binary is not needed
    // since the adapter is constructed fresh per executor with binaryPath — but we create a
    // new executor pointing at fake2 to verify the resume sessionId is forwarded).
    const profileConfig2 = {
      ...profileConfig,
      opencode: { ...profileConfig.opencode!, binaryPath: fake2.path },
    };

    const result2 = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'second message',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: opencodeCapability(profileConfig2),
      profileConfig: profileConfig2,
      sessions,
      sessionCatalog,
      workspaces,
      executor: makeExecutor(fake2.path),
      now: 2000,
    });
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error('second run failed to start');
    expect(result2.cwdRealpath).toBe(workspaceRealpath);
    // Resume from the previously recorded session.
    expect(result2.resumeFrom).toBe(firstSessionId);

    const events2: AgentEvent[] = [];
    for await (const evt of result2.execution.subscribe()) {
      events2.push(evt);
      recordRunSessionEvent({
        scopeId: 'chat-1',
        sessions,
        sessionCatalog,
        capability: opencodeCapability(profileConfig2),
        policy: result2.policy,
        event: evt,
      });
    }
    expect(events2).toEqual([
      { type: 'system', sessionId: secondSessionId },
      { type: 'final_text', content: 'second reply' },
      { type: 'done', sessionId: secondSessionId, terminationReason: 'normal' },
    ]);

    // Flush pending persists before assertions and cleanup.
    await sessions.flush();
    await sessionCatalog.flush();

    // Verify second run updated the catalog entry to sess-b.
    const entries2 = sessionCatalog.entries();
    expect(entries2).toHaveLength(1);
    expect(entries2[0]?.sessionId).toBe(secondSessionId);

    const rec2 = await readRecord(fake2.recordPath);
    // Resume: --session sess-a must be in argv.
    expect(rec2.argv).toContain('--session');
    expect(rec2.argv[rec2.argv.indexOf('--session') + 1]).toBe(firstSessionId);
    expect(rec2.argv).toContain('--auto');
    expect(rec2.argv[rec2.argv.indexOf('--agent') + 1]).toBe('build');

    // tmp cleanup runs last.
    cleanups.push(tmp.cleanup);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function createFakeOpencode(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-e2e-test-'));
  const path = join(dir, 'fake-opencode.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(
  path: string,
): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string | undefined>;
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: Record<string, string | undefined>;
  };
}
