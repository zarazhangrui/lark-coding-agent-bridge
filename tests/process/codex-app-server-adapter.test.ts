import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../../src/agent/codex/app-server-adapter.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types.js';

interface FakeAppServer {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodexAppServerAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = oldAppSecret;
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('runs the initialize -> thread/start -> turn/start handshake and translates events', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
      larkChannel: {
        profile: 'codex-app-server',
        rootDir: join(fake.dir, 'channel-home'),
        configPath: join(fake.dir, 'config.json'),
        larkCliConfigDir: join(fake.dir, 'lark-cli'),
      },
    });
    adapter.setBotIdentity({ openId: 'ou_bot', name: 'Bridge Bot' });

    const run = await prepareAndRun(adapter, {
      runId: 'run-fresh',
      prompt: 'hello from lark',
      threadName: '飞书 · hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-fresh', cwd, model: 'fake-model' },
      { type: 'thinking', delta: 'checking' },
      {
        type: 'tool_use',
        id: 'cmd-1',
        name: 'Bash',
        input: { command: 'pwd', cwd, commandActions: [] },
      },
      { type: 'tool_result', id: 'cmd-1', output: `${cwd}\n`, isError: false },
      { type: 'final_text', content: 'hello user' },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 4,
        reasoningOutputTokens: 1,
      },
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);

    const record = await readRecord(fake.recordPath);
    expect(record.argv.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(record.argv).toContain('notify=[]');
    expect(record.argv).toContain('include_apps_instructions=false');
    expect(record.argv).toContain('apps');
    expect(record.argv).toContain('plugins');
    expect(record.argv).toContain('browser_use');
    expect(record.argv).toContain('computer_use');
    const mcpOverride = record.argv.find((arg) => arg.startsWith('mcp_servers={'));
    expect(mcpOverride).toContain(
      '"fake-http"={enabled=false,url="http://127.0.0.1"}',
    );
    expect(mcpOverride).toContain(
      '"fake-stdio"={enabled=false,command="disabled-by-lark-channel-bridge"}',
    );
    expect(record.argv.join('\n')).not.toContain('unsafe-mcp-command');
    expect(record.argv.join('\n')).not.toContain('https://mcp.example.invalid');
    expect(record.argv.join('\n')).not.toContain('fake-secret-value');
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-app-server',
      LARK_CHANNEL_HOME: join(fake.dir, 'channel-home'),
      LARK_CHANNEL_CONFIG: join(fake.dir, 'config.json'),
      LARKSUITE_CLI_CONFIG_DIR: join(fake.dir, 'lark-cli'),
      CODEX_HOME: '/outer/codex-home',
      APP_SECRET: 'inherited-secret',
    });
    expect(record.messages.map((message) => message.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/name/set',
      'turn/start',
    ]);

    const threadStart = messageByMethod(record, 'thread/start');
    expect(threadStart.params).toMatchObject({
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'lark-channel-bridge',
      threadSource: 'user',
      ephemeral: false,
    });
    expect(threadStart.params.developerInstructions).toContain('lark-channel-bridge 运行约定');
    expect(threadStart.params.developerInstructions).toContain('ou_bot');
    expect(JSON.stringify(threadStart)).not.toContain('hello from lark');
    expect(messageByMethod(record, 'thread/name/set').params).toEqual({
      threadId: 'thread-fresh',
      name: '飞书 · hello from lark',
    });

    const turnStart = messageByMethod(record, 'turn/start');
    expect(turnStart.params).toMatchObject({
      threadId: 'thread-fresh',
      cwd,
      approvalPolicy: 'never',
      input: [{ type: 'text', text: 'hello from lark' }],
    });
  });

  it('resumes a thread and passes model, sandbox, and local images in protocol params', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(cwd, 'image.png');

    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'danger-full-access',
    });
    const run = await prepareAndRun(adapter, {
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      model: 'gpt-test',
      images: [image],
      sandbox: 'workspace-write',
    });

    const events = await collect(run.events);
    expect(await run.waitForExit(1000)).toBe(true);
    expect(events.at(0)).toEqual({
      type: 'system',
      threadId: 'thread-old',
      cwd,
      model: 'gpt-test',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.messages.some((message) => message.method === 'thread/start')).toBe(false);
    expect(record.messages.some((message) => message.method === 'thread/name/set')).toBe(false);
    expect(messageByMethod(record, 'thread/resume').params).toMatchObject({
      threadId: 'thread-old',
      cwd,
      model: 'gpt-test',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
    expect(messageByMethod(record, 'turn/start').params).toMatchObject({
      threadId: 'thread-old',
      model: 'gpt-test',
      input: [
        { type: 'text', text: 'continue' },
        { type: 'localImage', path: image },
      ],
    });
    expect(record.argv).not.toContain('continue');
    expect(record.argv).not.toContain(image);
  });

  it('declines unexpected approval requests under approvalPolicy never', async () => {
    const fake = await createFakeAppServer({ approvalRequest: true });
    cleanup.push(fake.dir);

    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    });
    const run = await prepareAndRun(adapter, {
      runId: 'run-approval',
      prompt: 'approval',
      cwd: await realpath(fake.dir),
    });

    expect((await collect(run.events)).at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-fresh',
      terminationReason: 'normal',
    });
    expect(await run.waitForExit(1000)).toBe(true);
    const record = await readRecord(fake.recordPath);
    expect(record.messages).toContainEqual({
      id: 'approval-1',
      result: { decision: 'decline' },
    });
  });

  it('buffers turn notifications that arrive before the turn/start response', async () => {
    const fake = await createFakeAppServer({ notificationsBeforeTurnResponse: true });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    });
    const run = await prepareAndRun(adapter, {
      runId: 'run-race',
      prompt: 'race',
      cwd,
    });

    const events = await collect(run.events);
    expect(await run.waitForExit(1000)).toBe(true);
    expect(events.at(0)).toMatchObject({ type: 'system', threadId: 'thread-fresh' });
    expect(events.filter((event) => event.type === 'done')).toEqual([
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([
      { type: 'final_text', content: 'hello user' },
    ]);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('interrupts an active turn before terminating its temporary app-server', async () => {
    const fake = await createFakeAppServer({ holdTurn: true });
    cleanup.push(fake.dir);
    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 100,
    });
    const run = await prepareAndRun(adapter, {
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: 'system', threadId: 'thread-fresh' },
    });
    await waitForRecordedMethod(fake.recordPath, 'turn/start');
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'thread-fresh', terminationReason: 'interrupted' },
    });
    expect(await run.waitForExit(1000)).toBe(true);
    const record = await readRecord(fake.recordPath);
    expect(messageByMethod(record, 'turn/interrupt').params).toEqual({
      threadId: 'thread-fresh',
      turnId: 'turn-1',
    });
    await iterator.return?.();
  });

  it('surfaces RPC rejection as a terminal error', async () => {
    const rejected = await createFakeAppServer({ failMethod: 'thread/start' });
    cleanup.push(rejected.dir);
    const rejectedAdapter = new CodexAppServerAdapter({
      binary: rejected.path,
      profileStateDir: rejected.dir,
    });
    const rejectedRun = await prepareAndRun(rejectedAdapter, {
      runId: 'run-rejected',
      prompt: 'fail',
      cwd: await realpath(rejected.dir),
    });
    expect(await collect(rejectedRun.events)).toEqual([
      {
        type: 'error',
        message: 'codex app-server protocol error: fake rejected thread/start',
        terminationReason: 'failed',
      },
    ]);
    expect(await rejectedRun.waitForExit(1000)).toBe(true);
  });

  it('surfaces malformed protocol as a terminal error', async () => {
    const malformed = await createFakeAppServer({ malformedAfterInitialize: true });
    cleanup.push(malformed.dir);
    const malformedAdapter = new CodexAppServerAdapter({
      binary: malformed.path,
      profileStateDir: malformed.dir,
    });
    const malformedRun = await prepareAndRun(malformedAdapter, {
      runId: 'run-malformed',
      prompt: 'fail',
      cwd: await realpath(malformed.dir),
    });
    expect(await collect(malformedRun.events)).toEqual([
      {
        type: 'error',
        message: 'codex app-server protocol error: codex app-server emitted malformed JSON',
        terminationReason: 'failed',
      },
    ]);
    expect(await malformedRun.waitForExit(1000)).toBe(true);
  });

  it('surfaces a missing app-server binary during preparation', async () => {
    const missing = join(tmpdir(), `missing-codex-app-server-${Date.now()}`);
    const adapter = new CodexAppServerAdapter({
      binary: missing,
      profileStateDir: tmpdir(),
    });
    await expect(
      adapter.prepareRun({ runId: 'run-missing', prompt: 'hi', cwd: tmpdir() }),
    ).rejects.toMatchObject({ code: 'agent-prepare-failed' });
  });

  it('uses a profile-local Codex home only when inheritance is disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const adapter = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
    });
    const run = await prepareAndRun(adapter, {
      runId: 'run-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    expect(await run.waitForExit(1000)).toBe(true);
    expect((await readRecord(fake.recordPath)).env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('requires cwd before spawning', () => {
    expect(() =>
      new CodexAppServerAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function prepareAndRun(
  adapter: CodexAppServerAdapter,
  options: AgentRunOptions,
): Promise<AgentRun> {
  await adapter.prepareRun(options);
  return adapter.run(options);
}

async function createFakeAppServer(options: {
  approvalRequest?: boolean;
  holdTurn?: boolean;
  failMethod?: string;
  malformedAfterInitialize?: boolean;
  notificationsBeforeTurnResponse?: boolean;
} = {}): Promise<FakeAppServer> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-adapter-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'record.json');
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const options = ${JSON.stringify(options)};
const recordPath = ${JSON.stringify(recordPath)};
const messages = [];
let threadId = 'thread-fresh';
let turnId = 'turn-1';
let completed = false;
let initializeReplied = false;
let configProbe = false;

function persist() {
  try {
    writeFileSync(recordPath, JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: {
        LARK_CHANNEL: process.env.LARK_CHANNEL,
        LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
        LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,
        LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,
        LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
        APP_SECRET: process.env.APP_SECRET,
      },
      messages,
    }, null, 2));
  } catch {
    // The test may already have removed its temp directory after collecting
    // the terminal event; late process-exit persistence is best-effort.
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function finish(status = 'completed') {
  if (completed) return;
  completed = true;
  if (status === 'completed') {
    send({ method: 'item/reasoning/summaryTextDelta', params: {
      threadId, turnId, itemId: 'reason-1', summaryIndex: 0, delta: 'checking'
    }});
    send({ method: 'item/started', params: {
      threadId, turnId, startedAtMs: Date.now(), item: {
        id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: process.cwd(),
        commandActions: [], status: 'inProgress'
      }
    }});
    send({ method: 'item/completed', params: {
      threadId, turnId, completedAtMs: Date.now(), item: {
        id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: process.cwd(),
        commandActions: [], status: 'completed', aggregatedOutput: process.cwd() + '\\n', exitCode: 0
      }
    }});
    send({ method: 'item/started', params: {
      threadId, turnId, startedAtMs: Date.now(),
      item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: '' }
    }});
    send({ method: 'item/agentMessage/delta', params: {
      threadId, turnId, itemId: 'msg-1', delta: 'hello user'
    }});
    send({ method: 'item/completed', params: {
      threadId, turnId, completedAtMs: Date.now(),
      item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'hello user' }
    }});
    send({ method: 'thread/tokenUsage/updated', params: {
      threadId, turnId, tokenUsage: {
        last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 },
        total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, reasoningOutputTokens: 10, totalTokens: 150 }
      }
    }});
  }
  send({ method: 'turn/completed', params: {
    threadId, turn: { id: turnId, status, items: [] }
  }});
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  messages.push(message);
  persist();
  if (message.method && options.failMethod === message.method) {
    send({ id: message.id, error: { code: -32000, message: 'fake rejected ' + message.method } });
    return;
  }
  if (message.method === 'initialize') {
    configProbe = message.params?.clientInfo?.name === 'lark-channel-bridge-config-probe';
    setTimeout(() => {
      initializeReplied = true;
      send({ id: message.id, result: {
        userAgent: 'fake-codex', codexHome: process.env.CODEX_HOME ?? '',
        platformFamily: 'unix', platformOs: 'macos'
      }});
      if (options.malformedAfterInitialize && !configProbe) process.stdout.write('{bad json\\n');
    }, 10);
  } else if (message.method === 'initialized' && !initializeReplied) {
    process.stderr.write('initialized arrived before initialize response\\n');
    process.exit(2);
  } else if (message.method === 'config/read') {
    send({ id: message.id, result: { config: { mcp_servers: {
      'fake-stdio': {
        enabled: true,
        command: 'unsafe-mcp-command',
        args: ['--token', 'fake-secret-value'],
        env: { SECRET: 'fake-secret-value' }
      },
      'fake-http': {
        enabled: true,
        url: 'https://mcp.example.invalid',
        bearer_token_env_var: 'FAKE_MCP_TOKEN'
      }
    } } } });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    threadId = message.params.threadId ?? 'thread-fresh';
    send({ id: message.id, result: {
      thread: { id: threadId }, cwd: message.params.cwd,
      model: message.params.model ?? 'fake-model', modelProvider: 'openai',
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {}
    }});
  } else if (message.method === 'thread/name/set') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    if (options.notificationsBeforeTurnResponse) finish('completed');
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (options.notificationsBeforeTurnResponse) {
      // Notifications were intentionally sent first to exercise client buffering.
    } else if (options.approvalRequest) {
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId, itemId: 'cmd-approval'
      }});
    } else if (!options.holdTurn) {
      finish('completed');
    }
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    finish('interrupted');
  } else if (message.id === 'approval-1' && message.result) {
    finish('completed');
  }
});

process.stdin.on('end', () => {
  persist();
  setTimeout(() => process.exit(0), 5);
});
process.on('SIGTERM', () => {
  persist();
  process.exit(0);
});
process.on('exit', persist);
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

interface FakeRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  messages: Array<{
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  }>;
}

async function readRecord(path: string): Promise<FakeRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeRecord;
}

function messageByMethod(record: FakeRecord, method: string) {
  const message = record.messages.find((candidate) => candidate.method === method);
  if (!message?.params) throw new Error(`missing recorded method: ${method}`);
  return { ...message, params: message.params };
}

async function waitForRecordedMethod(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      if ((await readRecord(path)).messages.some((message) => message.method === method)) return;
    } catch {
      // The fake may not have persisted its first request yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${method}`);
}
