import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraeAdapter } from '../../src/agent/trae/adapter.js';
import { buildTraeArgs } from '../../src/agent/trae/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('TraeAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldTraeHome = process.env.TRAE_HOME;

  afterEach(async () => {
    if (oldTraeHome === undefined) {
      delete process.env.TRAE_HOME;
    } else {
      process.env.TRAE_HOME = oldTraeHome;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns Trae JSON runs with prompt on stdin and captures thread id from stderr', async () => {
    process.env.TRAE_HOME = '/outer/trae-home';
    const fake = await createFakeTrae({
      lines: [
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'hello' } },
        { type: 'turn.completed' },
      ],
      stderr: 'INFO session_loop{thread_id=019ef7db-d096-7490-8aba-d7eeafd4f2da}: start\n',
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new TraeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-trae',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
      { type: 'text', delta: 'hello' },
      {
        type: 'done',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        terminationReason: 'normal',
      },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildTraeArgs({ cwd, sandbox: 'read-only' }));
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      TRAE_HOME: '/outer/trae-home',
    });
  });

  it('passes resume thread, image flags, and profile-local Trae home', async () => {
    const fake = await createFakeTrae({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new TraeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritTraeHome: false,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
      {
        type: 'done',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        terminationReason: 'normal',
      },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildTraeArgs({
        cwd,
        sandbox: 'workspace-write',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        images: [image],
      }),
    );
    expect(record.env.TRAE_HOME).toBe(join(fake.dir, 'trae-home'));
  });

  it('captures thread id from stderr even when the line is not newline-terminated', async () => {
    const fake = await createFakeTrae({
      lines: [{ type: 'turn.completed' }],
      stderr: 'INFO session_loop{thread_id=019ef7db-d096-7490-8aba-d7eeafd4f2da}: start',
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new TraeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-trae',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
      {
        type: 'done',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        terminationReason: 'normal',
      },
    ]);
  });

  it('captures thread id that arrives after the initial stderr wait', async () => {
    const fake = await createFakeTrae({
      lines: [{ type: 'turn.completed' }],
      stderr: 'INFO session_loop{thread_id=019ef7db-d096-7490-8aba-d7eeafd4f2da}: start\n',
      stderrDelayMs: 2100,
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new TraeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-trae-late-thread',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
      {
        type: 'done',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        terminationReason: 'normal',
      },
    ]);
  });

  it('captures thread id from alternate stderr keys and json logs', async () => {
    const cases = [
      'INFO threadId=019ef7db-d096-7490-8aba-d7eeafd4f2da',
      '{"type":"session.started","session_id":"019ef7db-d096-7490-8aba-d7eeafd4f2da"}',
    ];

    for (const stderr of cases) {
      const fake = await createFakeTrae({
        lines: [{ type: 'turn.completed' }],
        stderr,
      });
      cleanup.push(fake.dir);
      const cwd = await realpath(fake.dir);

      const run = new TraeAdapter({
        binary: fake.path,
        profileStateDir: fake.dir,
        sandbox: 'read-only',
      }).run({
        runId: 'run-trae-alt-thread',
        prompt: 'hello from lark',
        cwd,
      });

      expect(await collect(run.events)).toEqual([
        { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
        {
          type: 'done',
          threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
          terminationReason: 'normal',
        },
      ]);
    }
  });

  it('captures thread id from Trae stdout session events', async () => {
    const fake = await createFakeTrae({
      lines: [
        { type: 'session.started', session_id: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new TraeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-trae-session-started',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da' },
      {
        type: 'done',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
        terminationReason: 'normal',
      },
    ]);
  });

  it('warns when a fresh Trae run finishes without a resumable thread id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = await createFakeTrae({
      lines: [
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'hello' } },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    try {
      const run = new TraeAdapter({
        binary: fake.path,
        profileStateDir: fake.dir,
        sandbox: 'read-only',
      }).run({
        runId: 'run-trae-no-thread',
        prompt: 'hello from lark',
        cwd,
      });

      expect(await collect(run.events)).toEqual([
        { type: 'text', delta: 'hello' },
        {
          type: 'done',
          threadId: undefined,
          terminationReason: 'normal',
        },
      ]);
      const warning = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warning).toContain('agent.trae-session-id-missing');
      expect(warning).toContain('runId=run-trae-no-thread');
      expect(warning).toContain('Trae resume will be unavailable for this run');
    } finally {
      warn.mockRestore();
    }
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeTrae(options: {
  lines: unknown[];
  stderr?: string;
  stderrDelayMs?: number;
  exitCode?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-adapter-test-'));
  const path = join(dir, 'fake-trae.mjs');
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
      '      TRAE_HOME: process.env.TRAE_HOME,',
      '    },',
      '  }));',
      options.stderr
        ? options.stderrDelayMs
          ? `  setTimeout(() => process.stderr.write(${JSON.stringify(options.stderr)}), ${options.stderrDelayMs});`
          : `  process.stderr.write(${JSON.stringify(options.stderr)});`
        : '',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${Math.max(0, options.stderrDelayMs ?? 0)});`,
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
    TRAE_HOME?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: {
      LARK_CHANNEL?: string;
      TRAE_HOME?: string;
    };
  };
}
