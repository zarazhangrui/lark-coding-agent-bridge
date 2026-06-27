import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('PiAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns pi with -p prompt, --mode json, and --append-system-prompt (bridge conventions)', async () => {
    const fake = await createFakePi({
      lines: [
        { type: 'session', id: 'sess-fresh', cwd: '/repo' },
        {
          type: 'message_update',
          message: {},
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
        },
        { type: 'agent_end', messages: [] },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({ runId: 'run-fresh', prompt: 'hello from lark', cwd });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fresh', cwd: '/repo' },
      { type: 'text', delta: 'hello' },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      expect.arrayContaining(['-p', '--mode', 'json', '--append-system-prompt']),
    );
    // new conversation: NO session flag — pi must create + persist a session
    // by default so the id survives for resume on the next turn
    expect(record.argv).not.toContain('--no-session');
    expect(record.argv).not.toContain('--session');
    // prompt is the value right after -p
    expect(record.argv[record.argv.indexOf('-p') + 1]).toBe('hello from lark');
    // bridge prompt is the value right after --append-system-prompt (NOT a fixed offset)
    const promptIdx = record.argv.indexOf('--append-system-prompt');
    expect(record.argv[promptIdx + 1]).toContain('lark-channel-bridge 运行约定');
    expect(record.argv[promptIdx + 1]).toContain('__bridge_cb');
    // cwd is passed via spawn, not a flag
    expect(record.argv).not.toContain('--cwd');
    expect(await realpath(record.cwd)).toBe(cwd);
  });

  it('passes --session for resume and inherits the user ~/.pi config by default', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      sessionId: 'sess-old',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--session');
    expect(record.argv).toContain('sess-old');
    expect(record.argv).not.toContain('--no-session');
    // default inherit: bridge must NOT override PI_CODING_AGENT_DIR (reuse user ~/.pi)
    expect(record.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('isolates PI_CODING_AGENT_DIR only when inheritPiAgentDir is false', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritPiAgentDir: false,
    }).run({ runId: 'run-iso', prompt: 'iso', cwd: await realpath(fake.dir) });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.PI_CODING_AGENT_DIR).toBe(join(fake.dir, 'pi-agent'));
  });

  it('includes stderr when pi exits non-zero before a terminal event', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-1', cwd: '/r' }],
      stderr: 'boom\n',
      exitCode: 1,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/r' },
      { type: 'error', message: 'pi exited with code 1: boom', terminationReason: 'failed' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<PiAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakePi({ lines: [], stderr: 'missing command\n', exitCode: 1 });
      cleanup.push(fake.dir);
      run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-pi-${Date.now()}`);
      run = new PiAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn pi|spawn returned no pid|pi exited with code/,
    );
  });

  it('reports interrupted termination when stopped before agent_end (SIGTERM does not rely on pi flush)', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-stop', cwd: '/r' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({ runId: 'run-stop', prompt: 'stop', cwd: await realpath(fake.dir) });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'sess-stop', cwd: '/r' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved before spawning', () => {
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
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, LARK_CHANNEL: process.env.LARK_CHANNEL } }));`,
      `const lines = ${JSON.stringify(options.lines)};`,
      'for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
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
  env: { PI_CODING_AGENT_DIR?: string; LARK_CHANNEL?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8'));
}
