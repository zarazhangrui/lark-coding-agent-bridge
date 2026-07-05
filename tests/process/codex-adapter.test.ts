import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodexAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
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

  it('spawns a fresh JSON run with prompt on stdin and inherits the user Codex home by default', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-fresh' },
        { type: 'agent_message', message: 'hello user' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-fresh' },
      { type: 'text', delta: 'hello user' },
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).toContain('--skip-git-repo-check');
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
      CODEX_HOME: '/outer/codex-home',
    });
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('injects the active bridge profile env while preserving Codex env overrides', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
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
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      CODEX_HOME: '/outer/codex-home',
    });
  });

  it('leaves CODEX_HOME unset by default so Codex can use the user login under ~/.codex', async () => {
    delete process.env.CODEX_HOME;
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-default-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBeUndefined();
  });

  it('passes image paths and resume thread through the Codex argv contract', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'workspace-write',
        threadId: 'thread-old',
        images: [image],
      }),
    );
  });

  it('lets per-run policy sandbox override the adapter default', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'danger-full-access',
    }).run({
      runId: 'run-policy-sandbox',
      prompt: 'policy sandbox',
      cwd,
      sandbox: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
  });

  it('honors a profile-configured Codex home', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const codexHome = join(fake.dir, 'custom-codex-home');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      codexHome,
    }).run({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(codexHome);
  });

  it('uses a profile-local Codex home only when inheritance is explicitly disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
    }).run({
      runId: 'run-profile-local-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('passes configured Codex ignore flags through the argv builder', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: false,
      ignoreRules: false,
    }).run({
      runId: 'run-flags',
      prompt: 'flags',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).not.toContain('--ignore-rules');
  });

  it('can explicitly isolate Codex from the user config', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: true,
    }).run({
      runId: 'run-ignore-user-config',
      prompt: 'flags',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--ignore-user-config');
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'agent_message', message: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'codex exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'includes the signal and stderr when Codex crashes before a terminal event',
    async () => {
      const fake = await createFakeCodex({
        lines: [{ type: 'agent_message', message: 'before crash' }],
        stderr: 'tls handshake eof\n',
        signal: 'SIGTRAP',
      });
      cleanup.push(fake.dir);

      const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-signal',
        prompt: 'crash',
        cwd: await realpath(fake.dir),
      });

      expect(await collect(run.events)).toEqual([
        { type: 'text', delta: 'before crash' },
        {
          type: 'error',
          message: 'codex exited with signal SIGTRAP: tls handshake eof',
          terminationReason: 'failed',
        },
      ]);
    },
  );

  it('continues after retryable raw error events and waits for the terminal turn event', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-retry' },
        {
          type: 'error',
          error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
        },
        { type: 'agent_message', message: 'after retry' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-retry',
      prompt: 'retry',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-retry' },
      { type: 'text', delta: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<CodexAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeCodex({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-codex-${Date.now()}`);
      run = new CodexAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn codex|spawn returned no pid|codex exited with code/,
    );
  });

  it('reports interrupted termination when stopped before a Codex terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
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
      value: { type: 'system', threadId: 'thread-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new CodexAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
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

async function createFakeCodex(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  signal?: NodeJS.Signals;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'fake-codex.mjs');
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
      '      CODEX_HOME: process.env.CODEX_HOME,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      options.signal
        ? `  setTimeout(() => process.kill(process.pid, ${JSON.stringify(options.signal)}), ${options.exitDelayMs ?? 0});`
        : `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
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
    CODEX_HOME?: string;
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
      CODEX_HOME?: string;
      APP_SECRET?: string;
      PATH?: string;
    };
  };
}
