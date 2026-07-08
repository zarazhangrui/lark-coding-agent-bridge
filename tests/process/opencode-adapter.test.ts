import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../../src/agent/opencode/adapter.js';
import { buildOpenCodeArgs } from '../../src/agent/opencode/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('OpenCodeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a JSON run with prompt on stdin and bridge env injected', async () => {
    const fake = await createFakeOpenCode({
      lines: [
        { type: 'step_start', sessionID: 'ses_fresh' },
        { type: 'text', part: { text: 'hello user' } },
        { type: 'step_finish', reason: 'stop' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const larkCliConfigDir = join(rootDir, 'profiles', 'opencode', 'lark-cli');

    const run = new OpenCodeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'opencode',
        rootDir,
        larkCliConfigDir,
      },
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'ses_fresh' },
      { type: 'text', delta: 'hello user' },
      { type: 'done', terminationReason: 'normal', sessionId: 'ses_fresh' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildOpenCodeArgs({ cwd }));
    expect(record.argv).not.toContain('--auto');
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'opencode',
      LARK_CHANNEL_HOME: rootDir,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume session and opt-in auto approval through argv', async () => {
    const fake = await createFakeOpenCode({
      lines: [{ type: 'step_finish', reason: 'stop' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpenCodeAdapter({ binary: fake.path, autoApprove: true }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      sessionId: 'ses_old',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildOpenCodeArgs({ cwd, sessionId: 'ses_old', autoApprove: true }),
    );
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeOpenCode({
      lines: [{ type: 'text', part: { text: 'before failure' } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new OpenCodeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'opencode exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new OpenCodeAdapter({ binary: 'unused' }).run({
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

async function createFakeOpenCode(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-test-'));
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
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  process.exit(${options.exitCode ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
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
    stdin: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
