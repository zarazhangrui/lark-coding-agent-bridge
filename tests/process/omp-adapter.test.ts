import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OmpAdapter } from '../../src/agent/omp/adapter';
import type { AgentEvent } from '../../src/agent/types';

interface FakeOmp {
  path: string;
  dir: string;
  recordPath: string;
}

interface OmpRecord {
  argv: string[];
  systemPrompt: string | null;
  promptMessage: string | null;
  images: unknown[];
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
  };
}

describe('OmpAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns omp in RPC mode and translates streamed text, tools, usage, and completion', async () => {
    const fake = await createFakeOmp();
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path }).run({
      runId: 'run-omp',
      prompt: 'hello omp',
      cwd: fake.dir,
    });

    expect(run.runId).toBe('run-omp');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-omp', model: 'test/model' },
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'OMP' },
      { type: 'final_text', content: 'Hello OMP' },
      {
        type: 'usage',
        inputTokens: 11,
        outputTokens: 2,
        cachedInputTokens: 3,
      },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'bash',
        input: { command: 'echo hi' },
      },
      { type: 'tool_result', id: 'call-1', output: 'hi\n', isError: false },
      { type: 'text', delta: 'Done' },
      { type: 'final_text', content: 'Done' },
      { type: 'usage', inputTokens: 12, outputTokens: 1 },
      { type: 'done', sessionId: 'sess-omp', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv.slice(0, 7)).toEqual([
      '--mode',
      'rpc',
      '--no-title',
      '--approval-mode',
      'yolo',
      '--append-system-prompt',
      record.argv[6],
    ]);
    expect(record.argv).toContain('--append-system-prompt');
    expect(record.argv).not.toContain('hello omp');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.promptMessage).toBe('hello omp');
    expect(record.images).toEqual([]);
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(await run.waitForExit(2000)).toBe(true);
  });

  it('passes resume and model after the base contract', async () => {
    const fake = await createFakeOmp();
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path }).run({
      runId: 'run-omp-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'workbuddy/cn:deepseek-v4.1-flash',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual([
      '--resume',
      'sess-old',
      '--model',
      'workbuddy/cn:deepseek-v4.1-flash',
    ]);
  });

  it('surfaces a prompt_result error as a terminal error event', async () => {
    const fake = await createFakeOmp({ promptStatus: 'error' });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path }).run({
      runId: 'run-omp-error',
      prompt: 'boom',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-omp', model: 'test/model' },
      { type: 'error', message: 'provider exploded', terminationReason: 'failed' },
    ]);
  });

  it('aborts a hanging run through the RPC abort command', async () => {
    const fake = await createFakeOmp({ hangOnPrompt: true });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path }).run({
      runId: 'run-omp-abort',
      prompt: 'hang',
      cwd: fake.dir,
    });
    const events = collect(run.events);
    await waitFor(() => existsSync(fake.recordPath));

    await run.stop();

    expect(await run.waitForExit(1000)).toBe(true);
    expect((await events).at(-1)).toEqual({
      type: 'done',
      sessionId: 'sess-omp',
      terminationReason: 'interrupted',
    });
  });

  it('fails clearly when the RPC bridge never becomes ready', async () => {
    const fake = await createFakeOmp({ readyDelayMs: 1000 });
    cleanup.push(fake.dir);

    const run = new OmpAdapter({ binary: fake.path, readyTimeoutMs: 50 }).run({
      runId: 'run-omp-ready-timeout',
      prompt: 'never',
      cwd: fake.dir,
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new OmpAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeOmp(options: {
  promptStatus?: 'completed' | 'error';
  hangOnPrompt?: boolean;
  readyDelayMs?: number;
} = {}): Promise<FakeOmp> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-adapter-test-'));
  const path = join(dir, 'fake-omp.mjs');
  const recordPath = join(dir, 'record.json');
  const script = [
    '#!/usr/bin/env node',
    'import { writeFileSync, readFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'const spIdx = argv.indexOf("--append-system-prompt");',
    'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
    'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    `setTimeout(() => send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }), ${options.readyDelayMs ?? 0});`,
    'let buffer = "";',
    'let recorded = false;',
    'const record = (frame) => {',
    '  if (recorded) return;',
    '  recorded = true;',
    `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '    argv,',
    '    systemPrompt,',
    '    promptMessage: frame && typeof frame.message === "string" ? frame.message : null,',
    '    images: frame && Array.isArray(frame.images) ? frame.images : [],',
    '    cwd: process.cwd(),',
    '    env: { LARK_CHANNEL: process.env.LARK_CHANNEL, LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE },',
    '  }));',
    '};',
    `const promptStatus = ${JSON.stringify(options.promptStatus ?? 'completed')};`,
    `const hang = ${options.hangOnPrompt === true};`,
    'const finishPrompt = (id) => {',
    '  if (promptStatus === "error") {',
    '    send({ type: "prompt_result", id, agentInvoked: true, status: "error", error: { message: "provider exploded" } });',
    '    return;',
    '  }',
    '  send({ type: "message_start", message: { role: "assistant", content: [] } });',
    '  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });',
    '  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OMP" } });',
    '  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello OMP" }], usage: { input: 11, output: 2, cacheRead: 3 } } });',
    '  send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });',
    '  send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "hi\\n" }] }, isError: false });',
    '  send({ type: "message_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "hi\\n" }], isError: false } });',
    '  send({ type: "message_start", message: { role: "assistant", content: [] } });',
    '  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 12, output: 1 } } });',
    '  send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });',
    '};',
    'const handle = (frame) => {',
    '  if (frame.type === "negotiate_protocol") {',
    '    send({ id: frame.id, type: "response", command: "negotiate_protocol", success: true });',
    '  } else if (frame.type === "get_state") {',
    '    send({ id: frame.id, type: "response", command: "get_state", success: true, data: { sessionId: "sess-omp", model: { id: "test/model" } } });',
    '  } else if (frame.type === "prompt") {',
    '    record(frame);',
    '    if (!hang) finishPrompt(frame.id);',
    '  } else if (frame.type === "abort") {',
    '    send({ id: frame.id, type: "response", command: "abort", success: true });',
    '    setTimeout(() => process.exit(0), 10);',
    '  }',
    '};',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk.toString("utf8");',
    '  let nl = buffer.indexOf("\\n");',
    '  while (nl !== -1) {',
    '    const line = buffer.slice(0, nl);',
    '    buffer = buffer.slice(nl + 1);',
    '    if (line.trim()) handle(JSON.parse(line));',
    '    nl = buffer.indexOf("\\n");',
    '  }',
    '});',
    'process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));',
  ].join('\n');

  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<OmpRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as OmpRecord;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
