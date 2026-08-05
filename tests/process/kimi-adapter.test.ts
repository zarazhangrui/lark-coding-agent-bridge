import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import { buildKimiArgs } from '../../src/agent/kimi/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('KimiAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns with the bridge-prefixed prompt on -p, stream-json output, and session resume args; ends stdin immediately', async () => {
    const fake = await createFakeKimi({ lines: [] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-kimi-argv',
      prompt: 'hello',
      cwd,
      sessionId: 'sess-old',
    });

    expect(run.runId).toBe('run-kimi-argv');
    // 等子进程退出（记录文件由 fake 在 stdin end / 兜底 timer 后写入）
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    // -p 携带 bridge 系统提示前缀 + 用户 prompt（kimi 把 prompt 放 argv，不放 stdin）
    expect(record.argv[1]?.startsWith('# lark-channel-bridge 运行约定')).toBe(true);
    expect(record.argv[1]).toContain('__bridge_cb');
    expect(record.argv[1]).toContain('LARK_CHANNEL_PROFILE');
    expect(record.argv[1]).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.argv[1]?.endsWith('hello')).toBe(true);
    // argv 精确等于 buildKimiArgs 结果：--output-format stream-json + --session 续接
    expect(record.argv).toEqual(buildKimiArgs({ prompt: record.argv[1]!, sessionId: 'sess-old' }));
    // kimi 不读 stdin：adapter 在 spawn 后立即 end，子进程未收到任何字节
    expect(record.stdin).toBe('');
    expect(record.stdinEnded).toBe(true);
    // bridge 环境注入
    expect(record.env.LARK_CHANNEL).toBe('1');
  });

  it('translates a stream-json run into tool_use, tool_result, text, and done carrying the resumed session id', async () => {
    const fake = await createFakeKimi({
      lines: [
        { role: 'meta', type: 'system.version', version: '0.33.0' },
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: 'tool_1',
              function: { name: 'Read', arguments: JSON.stringify({ path: 'probe.txt' }) },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tool_1', content: 'file contents' },
        { role: 'assistant', content: '回复文本' },
        { role: 'meta', type: 'session.resume_hint', session_id: 'sess-kimi' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new KimiAdapter({ binary: fake.path }).run({
      runId: 'run-kimi-stream',
      prompt: 'hello',
      cwd,
      sessionId: 'sess-old',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'probe.txt' } },
      { type: 'tool_result', id: 'tool_1', output: 'file contents', isError: false },
      { type: 'system', sessionId: 'sess-kimi' },
      { type: 'text', delta: '回复文本' },
      { type: 'done', sessionId: 'sess-kimi', terminationReason: 'normal' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeKimi(options: { lines: unknown[] }): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-adapter-test-'));
  const path = join(dir, 'fake-kimi.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'let stdinEnded = false;',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'const finish = () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    stdinEnded,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      '  setTimeout(() => process.exit(0), 0);',
      '};',
      'process.stdin.on("end", () => { stdinEnded = true; finish(); });',
      // Fallback so a regression (adapter no longer ending stdin) fails the
      // `stdinEnded` assertion instead of hanging the suite until timeout.
      'setTimeout(() => { if (!stdinEnded) finish(); }, 2000);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  stdinEnded: boolean;
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
    stdinEnded: boolean;
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
