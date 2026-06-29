import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../../src/agent/antigravity/adapter.js';
import { buildAntigravityArgs } from '../../src/agent/antigravity/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('AntigravityAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns print mode with prompt on stdin and records the conversation id from the log', async () => {
    const fake = await createFakeAntigravity({
      stdout: 'hello from agy',
      log: 'I0000 server.go:788] Created conversation 11111111-1111-4111-8111-111111111111\n',
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new AntigravityAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'hello from agy' },
      { type: 'system', threadId: '11111111-1111-4111-8111-111111111111' },
      { type: 'done', threadId: '11111111-1111-4111-8111-111111111111', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    const logFile = record.argv[record.argv.indexOf('--log-file') + 1];

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildAntigravityArgs({
      cwd,
      sandbox: 'workspace-write',
      logFile,
    }));
    expect(record.argv).toContain('--sandbox');
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('hello from lark');
  }, 10_000);

  it('resumes an existing conversation and maps full access to skipped permissions', async () => {
    const fake = await createFakeAntigravity({ stdout: 'resumed' });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new AntigravityAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: '22222222-2222-4222-8222-222222222222',
      sandbox: 'danger-full-access',
      model: 'Gemini 3.5 Flash (High)',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '22222222-2222-4222-8222-222222222222' },
      { type: 'text', delta: 'resumed' },
      { type: 'done', threadId: '22222222-2222-4222-8222-222222222222', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--conversation');
    expect(record.argv).toContain('22222222-2222-4222-8222-222222222222');
    expect(record.argv).toContain('--dangerously-skip-permissions');
    expect(record.argv).not.toContain('--sandbox');
    expect(record.argv).toContain('Gemini 3.5 Flash (High)');
  }, 10_000);

  it('decodes UTF-8 stdout across chunk boundaries without replacement characters', async () => {
    const text = '系统服务（System Services）\n这是 Framework 的核心灵魂。';
    const fake = await createFakeAntigravity({
      stdout: text,
      splitStdoutBytes: [1, 2, 3, 5, 8, 13],
    });
    cleanup.push(fake.dir);

    const run = new AntigravityAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-utf8',
      prompt: '中文',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    const combined = events
      .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.delta)
      .join('');

    expect(combined).toBe(text);
    expect(combined).not.toContain('�');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  }, 10_000);

  it('surfaces empty output with the last log error', async () => {
    const fake = await createFakeAntigravity({
      stdout: '',
      log: 'E0000 log.go:398] FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n',
    });
    cleanup.push(fake.dir);

    const run = new AntigravityAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-empty',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'error',
        message: 'antigravity produced no output: FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
        terminationReason: 'failed',
      },
    ]);
  }, 10_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeAntigravity(options: {
  stdout: string;
  log?: string;
  exitCode?: number;
  splitStdoutBytes?: number[];
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-adapter-test-'));
  const path = join(dir, 'fake-agy.mjs');
  const recordPath = join(dir, 'record.json');
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
const argv = process.argv.slice(2);
const logFile = argv[argv.indexOf('--log-file') + 1];
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(logFile, ${JSON.stringify(options.log ?? '')});
}
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  argv,
  cwd: process.cwd(),
  stdin,
}, null, 2));
const stdout = Buffer.from(${JSON.stringify(options.stdout)}, 'utf8');
const splits = ${JSON.stringify(options.splitStdoutBytes ?? [])};
let offset = 0;
for (const size of splits) {
  if (offset >= stdout.length) break;
  process.stdout.write(stdout.subarray(offset, Math.min(offset + size, stdout.length)));
  offset += size;
}
if (offset < stdout.length) process.stdout.write(stdout.subarray(offset));
process.exit(${options.exitCode ?? 0});
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{ argv: string[]; cwd: string; stdin: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { argv: string[]; cwd: string; stdin: string };
}
