import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MimoAdapter } from '../../src/agent/mimo/adapter.js';
import { buildMimoArgs } from '../../src/agent/mimo/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('MimoAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run, prefixed prompt on stdin, and flushes final_text at exit', async () => {
    const fake = await createFakeMimo({
      lines: [
        { type: 'step_start', sessionID: 'ses-fresh', part: { type: 'step-start' } },
        { type: 'text', part: { type: 'text', text: 'hello ' } },
        { type: 'text', part: { type: 'text', text: 'user' } },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new MimoAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'ses-fresh' },
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'user' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', sessionId: 'ses-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildMimoArgs({ cwd }));
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
    expect(record.argv).not.toContain('--thinking');
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
  });

  it('survives non-JSON startup lines (database migration banner) before the event stream', async () => {
    const fake = await createFakeMimo({
      banner: ['Performing one time database migration...', 'sqlite-migration:done'],
      lines: [
        { type: 'step_start', sessionID: 'ses-banner', part: { type: 'step-start' } },
        { type: 'text', part: { type: 'text', text: 'ok' } },
      ],
    });
    cleanup.push(fake.dir);

    const events = await collect(
      new MimoAdapter({ binary: fake.path }).run({
        runId: 'run-banner',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      }).events,
    );

    expect(events).toEqual([
      { type: 'system', sessionId: 'ses-banner' },
      { type: 'text', delta: 'ok' },
      { type: 'final_text', content: 'ok' },
      { type: 'done', sessionId: 'ses-banner', terminationReason: 'normal' },
    ]);
  });

  it('passes session, model, thinking, images, and permissions through argv', async () => {
    const fake = await createFakeMimo({ lines: [] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new MimoAdapter({ binary: fake.path, thinking: true }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      sessionId: 'ses-old',
      model: 'newapi/deepseek-v4-flash',
      images: [image],
      sandbox: 'danger-full-access',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildMimoArgs({
        cwd,
        sessionId: 'ses-old',
        model: 'newapi/deepseek-v4-flash',
        thinking: true,
        skipPermissions: true,
        images: [image],
      }),
    );
  });

  it('omits --dangerously-skip-permissions for stricter access modes', async () => {
    const fake = await createFakeMimo({ lines: [] });
    cleanup.push(fake.dir);

    const run = new MimoAdapter({ binary: fake.path }).run({
      runId: 'run-strict',
      prompt: 'read only',
      cwd: await realpath(fake.dir),
      sandbox: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
  });

  it('reports interrupted termination when stopped before exit', async () => {
    const fake = await createFakeMimo({
      lines: [{ type: 'step_start', sessionID: 'ses-stop', part: { type: 'step-start' } }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new MimoAdapter({ binary: fake.path, stopGraceMs: 20 }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'ses-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'ses-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('finishes normally when the process stays silent past the idle timeout (background writer tail)', async () => {
    // mimo keeps running for its checkpoint-writer after the answer; the
    // adapter should surface done once streaming has been quiet long enough.
    const fake = await createFakeMimo({
      lines: [
        { type: 'step_start', sessionID: 'ses-idle', part: { type: 'step-start' } },
        { type: 'text', part: { type: 'text', text: 'final answer' } },
      ],
      exitDelayMs: 60_000,
    });
    cleanup.push(fake.dir);

    const run = new MimoAdapter({ binary: fake.path, idleTimeoutMs: 500 }).run({
      runId: 'run-idle',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events).toEqual([
      { type: 'system', sessionId: 'ses-idle' },
      { type: 'text', delta: 'final answer' },
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'ses-idle', terminationReason: 'normal' },
    ]);
    // The child was SIGTERMed by the idle finish; waitForExit should resolve.
    expect(await run.waitForExit(2_000)).toBe(true);
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeMimo({
      lines: [{ type: 'text', part: { type: 'text', text: 'before failure' } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new MimoAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'mimo exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-mimo-${Date.now()}`);
    const run = new MimoAdapter({ binary: missing }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn mimo|spawn returned no pid/,
    );
  });

  it('requires cwd to be resolved before spawning', () => {
    expect(() =>
      new MimoAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeMimo(options: {
  lines: unknown[];
  banner?: string[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'mimo-adapter-test-'));
  const path = join(dir, 'fake-mimo.mjs');
  const recordPath = join(dir, 'argv.json');
  const banner = (options.banner ?? []).map((line) => `console.log(${JSON.stringify(line)});`).join('\n');
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
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      banner,
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
      PATH?: string;
    };
  };
}
