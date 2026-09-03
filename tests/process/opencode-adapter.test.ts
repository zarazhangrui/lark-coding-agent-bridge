import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpencodeAdapter } from '../../src/agent/opencode/adapter.js';
import { buildOpencodeArgs } from '../../src/agent/opencode/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('OpencodeAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldConfigDir = process.env.OPENCODE_CONFIG_DIR;

  afterEach(async () => {
    if (oldConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = oldConfigDir;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with prompt on stdin and emits AgentEvents', async () => {
    const fake = await createFakeOpencode({
      lines: [
        { type: 'text', timestamp: 1, sessionID: 'sess-fresh', part: { type: 'text', text: 'hello user', time: { end: 2 } } },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpencodeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      access: 'read-only',
    }).run({ runId: 'run-fresh', prompt: 'hello from lark', cwd });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fresh' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildOpencodeArgs({ cwd, access: 'read-only', prompt: 'hello from lark' }));
    expect(record.argv).not.toContain('--auto');
    expect(record.argv).toContain('--agent');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('plan');
    // Prompt on stdin, NOT argv:
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
  });

  it('uses build agent + --auto for full access', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'full' }).run({ runId: 'r', prompt: 'p', cwd });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--auto');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('build');
  });

  it('sets OPENCODE_CONFIG_DIR to a profile-local dir when inheritConfig is false', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only', inheritConfig: false }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.OPENCODE_CONFIG_DIR).toBe(join(fake.dir, 'opencode-config'));
  });

  it('leaves OPENCODE_CONFIG_DIR unset by default to inherit user config', async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only' }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it('lets per-run accessMode override the adapter default', async () => {
    const fake = await createFakeOpencode({
      lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpencodeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      access: 'full',
    }).run({
      runId: 'run-policy-access',
      prompt: 'policy access',
      cwd,
      accessMode: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildOpencodeArgs({ cwd, access: 'read-only', prompt: 'policy access' }));
    expect(record.argv).not.toContain('--auto');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('plan');
  });

  it('forwards --session and --model through the argv contract', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'full' }).run({
      runId: 'r', prompt: 'p', cwd, sessionId: 'sess-old', model: 'anthropic/claude-opus-4-8',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildOpencodeArgs({ cwd, access: 'full', prompt: 'p', sessionId: 'sess-old', model: 'anthropic/claude-opus-4-8' }));
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeOpencode({ lines: [], stderr: 'boom\n', exitCode: 42 });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only' }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    expect(await collect(run.events)).toEqual([
      { type: 'error', message: 'opencode exited with code 42: boom', terminationReason: 'failed' },
    ]);
  });

  it('requires cwd', () => {
    expect(() =>
      new OpencodeAdapter({ binary: '/x/opencode', profileStateDir: '/x', access: 'read-only' }).run({ runId: 'r', prompt: 'p' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeOpencode(options: {
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
      '      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,',
      '      PATH: process.env.PATH,',
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
  cwd: string;
  stdin: string;
  env: { LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string; LARK_CHANNEL_HOME?: string; LARK_CHANNEL_CONFIG?: string; LARKSUITE_CLI_CONFIG_DIR?: string; OPENCODE_CONFIG_DIR?: string; PATH?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[]; cwd: string; stdin: string;
    env: { LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string; LARK_CHANNEL_HOME?: string; LARK_CHANNEL_CONFIG?: string; LARKSUITE_CLI_CONFIG_DIR?: string; OPENCODE_CONFIG_DIR?: string; PATH?: string };
  };
}
