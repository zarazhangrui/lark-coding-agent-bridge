import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import { buildGrokArgs } from '../../src/agent/grok/argv.js';
import { buildBridgeSystemPrompt } from '../../src/agent/bridge-system-prompt.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('GrokAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with prompt-file, streaming-messages-json, and bridge prompt', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
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
    expect(record.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(record.argv).toEqual(
      buildGrokArgs({
        promptFile: record.promptFile,
        cwd: fake.dir,
        permissionMode: 'acceptEdits',
        rules: record.rules ?? undefined,
      }),
    );
    expect(record.argv).not.toContain('hello');
    expect(record.prompt).toBe('hello');
    expect(record.rules).toBe(buildBridgeSystemPrompt(undefined));
    expect(record.rules).toContain('lark-channel-bridge 运行约定');
    expect(record.rules).toContain('__bridge_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'grok-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'grok-dev', 'lark-cli-source', 'config.json');

    const run = new GrokAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'grok-dev',
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
      LARK_CHANNEL_PROFILE: 'grok-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      GROK_DISABLE_AUTOUPDATER: '1',
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'grok-4.6',
      sandbox: 'workspace-write',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'grok-4.6']);
    expect(record.argv).not.toContain('--sandbox');
  });

  it('lists attached image paths in the prompt file', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'result', session_id: 'sess-img' }],
    });
    cleanup.push(fake.dir);
    const imagePath = join(fake.dir, 'photo.png');

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-images',
      prompt: 'look',
      cwd: fake.dir,
      images: [imagePath],
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.prompt).toContain('look');
    expect(record.prompt).toContain('<attached_images>');
    expect(record.prompt).toContain(imagePath);
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeGrok({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'grok exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('does not emit a second error when the stream already ended with a result error', async () => {
    const fake = await createFakeGrok({
      lines: [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'boom',
          session_id: 'sess-err',
        },
      ],
      stderr: 'ignored\n',
      exitCode: 1,
    });
    cleanup.push(fake.dir);

    const run = new GrokAdapter({ binary: fake.path }).run({
      runId: 'run-result-error',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'error', message: 'boom', terminationReason: 'failed' },
    ]);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new GrokAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeGrok(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-adapter-test-'));
  const path = join(dir, 'fake-grok.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const pfIdx = argv.indexOf("--prompt-file");',
      'const promptFile = pfIdx !== -1 ? argv[pfIdx + 1] : "";',
      'const prompt = promptFile ? readFileSync(promptFile, "utf8") : "";',
      'const rulesIdx = argv.indexOf("--rules");',
      'const rules = rulesIdx !== -1 ? argv[rulesIdx + 1] : null;',
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '  argv,',
      '  prompt,',
      '  promptFile,',
      '  rules,',
      '  cwd: process.cwd(),',
      '  env: {',
      '    LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,',
      '  },',
      '}));',
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
  prompt: string;
  promptFile: string;
  rules: string | null;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
    GROK_DISABLE_AUTOUPDATER?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    prompt: string;
    promptFile: string;
    rules: string | null;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
      GROK_DISABLE_AUTOUPDATER?: string;
    };
  };
}
