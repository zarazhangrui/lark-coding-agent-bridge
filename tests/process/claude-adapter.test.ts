import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.argv.slice(0, 8)).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
    ]);
    expect(record.argv[8]).toContain('lark-channel-bridge 运行约定');
    expect(record.argv[8]).toContain('__bridge_cb');
    expect(record.argv[8]).toContain('LARK_CHANNEL_PROFILE');
    expect(record.argv[8]).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.argv[8]).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.argv[8]).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'codex-dev',
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
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    expect(record.argv[6]).toBe('bypassPermissions');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

// How the claude CLI surfaces a 403: a synthetic assistant turn (its only
// "content" is the error string) followed by a result line with is_error set,
// then exit 1. Captured from a real `claude -p` run against a 403 endpoint.
const AUTH_403_SCENARIO = {
  lines: [
    { type: 'system', subtype: 'init', session_id: 'sess-fail', model: '<synthetic>' },
    {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Failed to authenticate. API Error: 403 Request not allowed' }],
      },
      error: 'authentication_failed',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 403,
      result: 'Failed to authenticate. API Error: 403 Request not allowed',
      session_id: 'sess-fail',
    },
  ],
  exitCode: 1,
};

const SUCCESS_SCENARIO = {
  lines: [
    { type: 'system', subtype: 'init', session_id: 'sess-ok', model: 'claude-sonnet' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello after retry' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sess-ok',
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  ],
  exitCode: 0,
};

describe('ClaudeAdapter transient auth/403 retry', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('retries a transient auth/403 failure and streams the next attempt cleanly', async () => {
    const fake = await createCountingClaude([AUTH_403_SCENARIO, SUCCESS_SCENARIO]);
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-retry',
      prompt: 'hi',
      cwd: fake.dir,
    });
    const events = await collect(run.events);

    // The 403 must never reach the user — no error, no auth text leaked.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'text' && e.delta.includes('authenticate'))).toBe(false);
    expect(events.find((e) => e.type === 'text')).toEqual({
      type: 'text',
      delta: 'hello after retry',
    });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'sess-ok', terminationReason: 'normal' });

    const invocations = await readInvocations(fake.invocationsPath);
    expect(invocations).toHaveLength(2);
    // The retry re-runs the caller's request fresh; it must not resume the
    // failed attempt's throwaway session.
    expect(invocations[1]!.argv).not.toContain('--resume');
  }, 15_000);

  it('does not retry a non-auth API error', async () => {
    const fake = await createCountingClaude([
      {
        lines: [
          { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 500,
            result: 'API Error: 500 Internal server error',
            session_id: 's',
          },
        ],
        exitCode: 1,
      },
    ]);
    cleanup.push(fake.dir);

    const events = await collect(
      new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-500', prompt: 'hi', cwd: fake.dir })
        .events,
    );

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: 'API Error: 500 Internal server error',
      terminationReason: 'failed',
    });
    expect(await readInvocations(fake.invocationsPath)).toHaveLength(1);
  });

  it('does not retry once real content has streamed, even on an auth error', async () => {
    const fake = await createCountingClaude([
      {
        lines: [
          { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } },
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 403,
            result: 'Failed to authenticate. API Error: 403 Request not allowed',
            session_id: 's',
          },
        ],
        exitCode: 1,
      },
    ]);
    cleanup.push(fake.dir);

    const events = await collect(
      new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-partial', prompt: 'hi', cwd: fake.dir })
        .events,
    );

    expect(events.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'partial answer' });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(await readInvocations(fake.invocationsPath)).toHaveLength(1);
  });

  it('surfaces the auth error to the user after exhausting retries', async () => {
    const fake = await createCountingClaude([AUTH_403_SCENARIO]); // every attempt fails
    cleanup.push(fake.dir);

    const events = await collect(
      new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-exhaust', prompt: 'hi', cwd: fake.dir })
        .events,
    );

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: 'Failed to authenticate. API Error: 403 Request not allowed',
      terminationReason: 'failed',
    });
    // 1 initial attempt + MAX_AUTH_RETRIES (3) re-spawns.
    expect(await readInvocations(fake.invocationsPath)).toHaveLength(4);
  }, 20_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeClaude(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  env: {',
      '    LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '  },',
      '}));',
      `const lines = ${JSON.stringify(options.lines)};`,
      'for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
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

interface Scenario {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
}

// A fake claude that behaves differently on each spawn: invocation N runs
// scenario N (the last scenario repeats once the list is exhausted), and every
// spawn appends its argv to a JSONL file so tests can assert how many times —
// and with what args — claude was re-run.
async function createCountingClaude(scenarios: Scenario[]): Promise<{
  path: string;
  dir: string;
  invocationsPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-retry-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const countPath = join(dir, 'count.json');
  const invocationsPath = join(dir, 'invocations.jsonl');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { readFileSync, writeFileSync, appendFileSync } from "node:fs";',
      `const countPath = ${JSON.stringify(countPath)};`,
      `const invocationsPath = ${JSON.stringify(invocationsPath)};`,
      `const scenarios = ${JSON.stringify(scenarios)};`,
      'let n = 0;',
      'try { n = JSON.parse(readFileSync(countPath, "utf8")).n; } catch {}',
      'n += 1;',
      'writeFileSync(countPath, JSON.stringify({ n }));',
      'appendFileSync(invocationsPath, JSON.stringify({ attempt: n, argv: process.argv.slice(2) }) + "\\n");',
      'const scenario = scenarios[Math.min(n - 1, scenarios.length - 1)];',
      'for (const line of scenario.lines) console.log(JSON.stringify(line));',
      'if (scenario.stderr) process.stderr.write(scenario.stderr);',
      'process.exit(scenario.exitCode ?? 0);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, invocationsPath };
}

async function readInvocations(path: string): Promise<{ attempt: number; argv: string[] }[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { attempt: number; argv: string[] });
}
