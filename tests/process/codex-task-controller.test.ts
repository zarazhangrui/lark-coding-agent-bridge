import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTaskController, finalAgentMessages } from '../../src/codex-task/controller';
import { CodexTaskRegistry } from '../../src/codex-task/registry';
import { writeFileAtomic } from '../../src/platform/atomic-write';

describe('CodexTaskController process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('creates, names, resumes, reads, and records a persistent worker task', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-A1B2C3',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });

    const created = await controller.create({
      title: 'Worker task',
      cwd: fake.dir,
      model: 'gpt-test',
    });
    expect('output' in created).toBe(false);
    if ('output' in created) throw new Error('unexpected execution result');
    expect(created).toMatchObject({
      handle: 'T-A1B2C3',
      title: 'Worker task',
      cwd: fake.dir,
      model: 'gpt-test',
      status: 'idle',
    });

    const sent = await controller.send(created.handle, { message: 'check status' });
    expect(sent).toMatchObject({
      task: { handle: 'T-A1B2C3', status: 'completed' },
      output: 'worker-ok: check status',
      terminationReason: 'normal',
    });

    const read = await controller.read(created.handle);
    expect(read.thread).toMatchObject({ id: 'thread-worker', name: 'Worker task' });
    expect(finalAgentMessages(read.thread)).toEqual(['worker-ok: check status']);
    expect(await controller.list()).toEqual([sent.task]);

    const invocations = JSON.parse(await readFile(fake.invocations, 'utf8')) as string[][];
    expect(invocations.length).toBeGreaterThanOrEqual(6);
    expect(invocations.every((argv) => argv.slice(0, 3).join(' ') === 'app-server --listen stdio://')).toBe(true);
    expect(invocations.some((argv) => argv.includes('apps') && argv.includes('computer_use'))).toBe(true);
    const persisted = JSON.parse(await readFile(fake.state, 'utf8')) as Record<string, unknown>;
    expect(persisted.resumeDeveloperInstructions).toContain('persistent Codex worker task');
    expect(persisted.resumeDeveloperInstructions).not.toContain('lark-channel-bridge 运行约定');
  });
});

async function createFakeAppServer(): Promise<{
  dir: string;
  binary: string;
  invocations: string;
  state: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-controller-'));
  const binary = join(dir, 'fake-codex.mjs');
  const state = join(dir, 'state.json');
  const invocations = join(dir, 'invocations.json');
  const source = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = ${JSON.stringify(state)};
const invocationsPath = ${JSON.stringify(invocations)};
const invocations = existsSync(invocationsPath) ? JSON.parse(readFileSync(invocationsPath, 'utf8')) : [];
invocations.push(process.argv.slice(2));
writeFileSync(invocationsPath, JSON.stringify(invocations));

let initialized = false;
let loadedThread;
let turnCounter = 0;
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
const save = (value) => writeFileSync(statePath, JSON.stringify(value));
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialized = true;
    send({ id: message.id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME ?? '' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: 'not initialized' } });
    return;
  }
  if (message.method === 'config/read') {
    send({ id: message.id, result: { config: { mcp_servers: {} } } });
    return;
  }
  if (message.method === 'thread/start') {
    loadedThread = 'thread-worker';
    send({ id: message.id, result: {
      thread: { id: loadedThread, sessionId: loadedThread, ephemeral: false },
      cwd: message.params.cwd,
      model: message.params.model ?? 'fake-default',
      modelProvider: 'fake'
    }});
    send({ method: 'thread/started', params: { thread: { id: loadedThread } } });
    return;
  }
  if (message.method === 'thread/name/set') {
    const current = load() ?? { id: message.params.threadId, cwd: process.cwd(), turns: [] };
    save({ ...current, name: message.params.name });
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'thread/resume') {
    const current = load();
    if (!current || current.id !== message.params.threadId) {
      send({ id: message.id, error: { code: -32000, message: 'thread not found' } });
      return;
    }
    loadedThread = current.id;
    save({ ...current, resumeDeveloperInstructions: message.params.developerInstructions });
    send({ id: message.id, result: {
      thread: current,
      cwd: message.params.cwd,
      model: message.params.model ?? 'gpt-test',
      modelProvider: 'fake'
    }});
    return;
  }
  if (message.method === 'thread/read') {
    const current = load();
    send({ id: message.id, result: { thread: message.params.includeTurns
      ? { ...current, status: { type: 'notLoaded' } }
      : { id: current.id, name: current.name, cwd: current.cwd, status: { type: 'notLoaded' } }
    }});
    return;
  }
  if (message.method === 'turn/start') {
    if (loadedThread !== message.params.threadId) {
      send({ id: message.id, error: { code: -32000, message: 'thread not loaded' } });
      return;
    }
    const turnId = 'turn-' + (++turnCounter);
    const text = 'worker-ok: ' + message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    setTimeout(() => {
      send({ method: 'item/started', params: {
        threadId: loadedThread, turnId, item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: '' }
      }});
      send({ method: 'item/agentMessage/delta', params: {
        threadId: loadedThread, turnId, itemId: 'msg-1', delta: text
      }});
      send({ method: 'item/completed', params: {
        threadId: loadedThread, turnId,
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text }
      }});
      const current = load();
      save({ ...current, turns: [...(current.turns ?? []), {
        id: turnId, status: 'completed', items: [{ id: 'msg-1', type: 'agentMessage', text }]
      }] });
      send({ method: 'turn/completed', params: {
        threadId: loadedThread, turn: { id: turnId, status: 'completed', items: [] }
      }});
    }, 10);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: 'unsupported ' + message.method } });
});

rl.on('close', () => process.exit(0));
`;
  await writeFileAtomic(binary, source, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { dir, binary, invocations, state };
}
