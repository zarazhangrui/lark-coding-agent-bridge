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
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldAppSecret === undefined) {
      delete process.env.APP_SECRET;
    } else {
      process.env.APP_SECRET = oldAppSecret;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin', async () => {
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeOpenCode({
      lines: [
        { type: 'text', part: { text: 'hello user' } },
        { type: 'step_finish' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpenCodeAdapter({
      binary: fake.path,
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'hello user' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildOpenCodeArgs({ cwd }));
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('lark-cli auth login');
    expect(record.stdin).toContain('LARK_CHANNEL_PROFILE');
    expect(record.stdin).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.stdin).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
    });
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('injects the active bridge profile env', async () => {
    const fake = await createFakeOpenCode({
      lines: [{ type: 'step_finish' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'opencode-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(
      rootDir,
      'profiles',
      'opencode-dev',
      'lark-cli-source',
      'config.json',
    );

    const run = new OpenCodeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'opencode-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'opencode-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
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

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<OpenCodeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeOpenCode({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new OpenCodeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-opencode-${Date.now()}`);
      run = new OpenCodeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn opencode|spawn returned no pid|opencode exited with code/,
    );
  });

  it('reports interrupted termination when stopped before an OpenCode terminal event', async () => {
    const fake = await createFakeOpenCode({
      lines: [{ type: 'text', part: { text: 'before stop' } }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new OpenCodeAdapter({
      binary: fake.path,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text', delta: 'before stop' },
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
  exitDelayMs?: number;
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
      '      APP_SECRET: process.env.APP_SECRET,',
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
    APP_SECRET?: string;
    PATH?: string;
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
      APP_SECRET?: string;
      PATH?: string;
    };
  };
}
