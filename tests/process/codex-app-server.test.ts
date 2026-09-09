import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('Codex app-server runtime', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('starts the daemon once, uses a proxy, and translates a persistent thread turn', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'read-only',
      reasoningEffort: 'medium',
      larkChannel: {
        profile: 'codex',
        rootDir: '/tmp/lark-channel',
        larkCliConfigDir: '/tmp/lark-channel/profiles/codex/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel/profiles/codex/lark-cli-source/config.json',
      },
    });

    const first = adapter.run({ runId: 'message-1', prompt: 'first prompt', cwd: fake.dir, model: 'gpt-5.6-terra' });
    expect(await collect(first.events)).toEqual([
      { type: 'system', threadId: 'thread-1', cwd: fake.dir },
      { type: 'final_text', content: 'hello from app-server' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);

    const second = adapter.run({
      runId: 'message-2',
      prompt: 'second prompt',
      cwd: fake.dir,
      threadId: 'thread-1',
    });
    expect((await collect(second.events)).at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-1',
      terminationReason: 'normal',
    });

    expect(JSON.parse(await readFile(fake.recordPath, 'utf8'))).toEqual([
      ['app-server', 'daemon', 'start'],
      ['app-server', 'proxy'],
    ]);
    const requests = JSON.parse(await readFile(fake.requestsPath, 'utf8')) as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: expect.stringContaining('lark-channel-bridge 运行约定'),
      model: 'gpt-5.6-terra',
      config: {
        model_reasoning_effort: 'medium',
        shell_environment_policy: {
          inherit: 'all',
          set: {
            LARK_CHANNEL: '1',
            LARK_CHANNEL_PROFILE: 'codex',
            LARK_CHANNEL_HOME: '/tmp/lark-channel',
            LARK_CHANNEL_CONFIG: '/tmp/lark-channel/profiles/codex/lark-cli-source/config.json',
            LARKSUITE_CLI_CONFIG_DIR: '/tmp/lark-channel/profiles/codex/lark-cli',
          },
        },
      },
    });
    expect(requests.find((request) => request.method === 'thread/resume')?.params).toMatchObject({
      config: {
        shell_environment_policy: {
          set: { LARK_CHANNEL_PROFILE: 'codex' },
        },
      },
    });
    expect(requests.filter((request) => request.method === 'turn/start')[0]?.params.input).toEqual([
      { type: 'text', text: 'first prompt' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeAppServer(): Promise<{
  path: string;
  dir: string;
  recordPath: string;
  requestsPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'commands.json');
  const requestsPath = join(dir, 'requests.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const recordPath = ${JSON.stringify(recordPath)};`,
      `const requestsPath = ${JSON.stringify(requestsPath)};`,
      'const args = process.argv.slice(2);',
      'const prior = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : [];',
      'prior.push(args); writeFileSync(recordPath, JSON.stringify(prior));',
      'if (args.join(" ") === "app-server daemon start") process.exit(0);',
      'if (args.join(" ") !== "app-server proxy") process.exit(2);',
      'let buffer = Buffer.alloc(0); let upgraded = false;',
      'function send(value) { const body = Buffer.from(JSON.stringify(value)); const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >>> 8, body.length & 255]); process.stdout.write(Buffer.concat([header, body])); }',
      'function handle(request) {',
      '  const requests = existsSync(requestsPath) ? JSON.parse(readFileSync(requestsPath, "utf8")) : [];',
      '  requests.push({ method: request.method, params: request.params }); writeFileSync(requestsPath, JSON.stringify(requests));',
      '  if (request.method === "initialize") send({ id: request.id, result: {} });',
      '  else if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });',
      '  else if (request.method === "thread/resume") send({ id: request.id, result: { thread: { id: request.params.threadId } } });',
      '  else if (request.method === "turn/start") {',
      '    send({ id: request.id, result: { turn: { id: "turn-1" } } });',
      '    setTimeout(() => {',
      '      send({ method: "item/agentMessage/delta", params: { threadId: request.params.threadId, turnId: "turn-1", itemId: "item-1", delta: "hello from app-server" } });',
      '      send({ method: "item/completed", params: { threadId: request.params.threadId, item: { id: "item-1", type: "agentMessage", text: "hello from app-server" } } });',
      '      send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: "turn-1", status: "completed" } } });',
      '    }, 10);',
      '  } else if (request.method === "turn/interrupt") {',
      '    send({ id: request.id, result: {} });',
      '    send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: request.params.turnId } } });',
      '  }',
      '}',
      'process.stdin.on("data", (chunk) => {',
      '  buffer = Buffer.concat([buffer, chunk]);',
      '  if (!upgraded) { const boundary = buffer.indexOf("\\r\\n\\r\\n"); if (boundary < 0) return; buffer = buffer.subarray(boundary + 4); upgraded = true; process.stdout.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n"); }',
      '  while (buffer.length >= 2) {',
      '    const opcode = buffer[0] & 15; const masked = (buffer[1] & 128) !== 0; let length = buffer[1] & 127; let offset = 2;',
      '    if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(offset); offset += 2; }',
      '    if (!masked || buffer.length < offset + 4 + length) return;',
      '    const mask = buffer.subarray(offset, offset + 4); offset += 4; const body = Buffer.from(buffer.subarray(offset, offset + length)); buffer = buffer.subarray(offset + length);',
      '    for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];',
      '    if (opcode === 1) handle(JSON.parse(body.toString("utf8")));',
      '  }',
      '});',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath, requestsPath };
}
