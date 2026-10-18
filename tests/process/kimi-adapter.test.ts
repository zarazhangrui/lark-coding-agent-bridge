import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prefixBridgeSystemPrompt } from '../../src/agent/bridge-system-prompt.js';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

const FULL_RUN_LINES = [
  { role: 'meta', type: 'system.version', version: '2.2.0' },
  { role: 'assistant', content: 'hello' },
  {
    role: 'assistant',
    tool_calls: [
      { id: 'tool_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'tool_1', content: 'out' },
  { role: 'meta', type: 'session.resume_hint', session_id: 'session_x', command: 'kimi -r session_x' },
];

const FULL_RUN_EVENTS: AgentEvent[] = [
  { type: 'text', delta: 'hello' },
  { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
  { type: 'tool_result', id: 'tool_1', output: 'out', isError: false },
  { type: 'system', sessionId: 'session_x' },
  { type: 'done', sessionId: 'session_x', terminationReason: 'normal' },
];

describe('KimiAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('passes the bridge-prefixed prompt as a single -p argv value and closes stdin', async () => {
    const fake = await createFakeKimi({ lines: FULL_RUN_LINES });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual(FULL_RUN_EVENTS);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // kimi reads the prompt from argv only: the bridge system prompt is
    // prefixed into the single -p value, and stdin carries nothing.
    expect(record.argv).toEqual([
      '-p',
      prefixBridgeSystemPrompt('hello', undefined),
      '--output-format',
      'stream-json',
    ]);
    expect(record.argv[1]).toContain('lark-channel-bridge 运行约定');
    expect(record.argv[1]).toContain('## user_message\n\nhello');
    expect(record.stdin).toBe('');
    expect(record.argv).not.toContain('-S');
    expect(record.argv).not.toContain('-m');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeKimi({
      lines: [
        { role: 'meta', type: 'session.resume_hint', session_id: 'session_profile' },
      ],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'kimi-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'kimi-dev', 'lark-cli-source', 'config.json');

    const run = new KimiAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'kimi-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'kimi-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('appends -S and -m after the base CLI contract only when given', async () => {
    const fake = await createFakeKimi({
      lines: [
        { role: 'meta', type: 'session.resume_hint', session_id: 'session_resumed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'session_old',
      model: 'kimi-code/k3',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'session_resumed' },
      { type: 'done', sessionId: 'session_resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(0, 2)).toEqual([
      '-p',
      prefixBridgeSystemPrompt('continue', undefined),
    ]);
    expect(record.argv.slice(2)).toEqual([
      '--output-format',
      'stream-json',
      '-S',
      'session_old',
      '-m',
      'kimi-code/k3',
    ]);
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeKimi({
      lines: [{ role: 'assistant', content: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'kimi exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('reports interrupted termination when stopped before a terminal event', async () => {
    const fake = await createFakeKimi({
      lines: [{ role: 'assistant', content: 'working' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
      stopGraceMs: 20,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text', delta: 'working' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new KimiAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeKimi(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-adapter-test-'));
  const path = join(dir, 'fake-kimi.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.on("data", (c) => { stdin += c; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    stdin,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
