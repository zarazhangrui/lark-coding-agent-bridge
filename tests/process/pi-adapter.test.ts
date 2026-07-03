import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import { buildPiArgs } from '../../src/agent/pi/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('PiAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldPiHome = process.env.PI_CODING_AGENT_DIR;

  afterEach(async () => {
    if (oldPiHome === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldPiHome;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and uses a profile-scoped pi home by default', async () => {
    const fake = await createFakePi({
      lines: [
        { type: 'session', id: 'sess-fresh' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hello user' },
        },
        { type: 'agent_end', messages: [] },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fresh' },
      { type: 'text', delta: 'hello user' },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildPiArgs({ accessMode: 'full' }));
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env.PI_CODING_AGENT_DIR).toBe(join(fake.dir, 'pi-home'));
  });

  it('passes image paths and a resumed session id through the argv contract', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      sessionId: 'sess-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'normal' }]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildPiArgs({ accessMode: 'full', sessionId: 'sess-old', images: [image] }),
    );
  });

  it('restricts tools for read-only access', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      accessMode: 'full',
    }).run({
      runId: 'run-readonly',
      prompt: 'look only',
      cwd,
      accessMode: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildPiArgs({ accessMode: 'read-only' }));
  });

  it('uses an explicit piHome verbatim, and honors inheritPiHome', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const piHome = join(fake.dir, 'custom-pi-home');

    const explicit = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir, piHome }).run({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });
    await collect(explicit.events);
    expect((await readRecord(fake.recordPath)).env.PI_CODING_AGENT_DIR).toBe(piHome);

    const inherited = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritPiHome: true,
    }).run({ runId: 'run-inherit', prompt: 'home', cwd });
    await collect(inherited.events);
    expect((await readRecord(fake.recordPath)).env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('injects the active bridge profile env while preserving the pi home override', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'pi-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'pi-dev', 'lark-cli-source', 'config.json');

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      larkChannel: {
        profile: 'pi-dev',
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
      LARK_CHANNEL_PROFILE: 'pi-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      PI_CODING_AGENT_DIR: join(fake.dir, 'pi-home'),
    });
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakePi({
      lines: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before failure' } },
      ],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      { type: 'error', message: 'pi exited with code 42: boom', terminationReason: 'failed' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-pi-${Date.now()}`);
    const run = new PiAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn pi|spawn returned no pid|pi exited with code/,
    );
  });

  it('reports interrupted termination when stopped before an agent_end event', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'sess-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new PiAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
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

async function createFakePi(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  const path = join(dir, 'fake-pi.mjs');
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
      '      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,',
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
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
    PI_CODING_AGENT_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8'));
}
