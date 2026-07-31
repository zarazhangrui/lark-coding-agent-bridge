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
      larkChannel: {
        rootDir: fake.dir,
        configPath: join(fake.dir, 'bridge.custom.json'),
        larkCliSourceConfigFile: join(fake.dir, 'lark-cli-source', 'config.json'),
      },
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
    expect(invocations.some((argv) => argv.slice(0, 2).join(' ') === 'features list')).toBe(true);
    expect(invocations
      .filter((argv) => argv[0] !== 'features')
      .every((argv) => argv.slice(0, 3).join(' ') === 'app-server --listen stdio://')).toBe(true);
    expect(invocations.some((argv) => argv.includes('apps') && argv.includes('computer_use'))).toBe(true);
    const environments = JSON.parse(await readFile(fake.environments, 'utf8')) as Array<Record<string, string>>;
    expect(environments).not.toHaveLength(0);
    expect(environments.every((env) => (
      env.LARK_CHANNEL_BRIDGE_CONFIG === join(fake.dir, 'bridge.custom.json')
      && env.LARK_CHANNEL_CONFIG === join(fake.dir, 'lark-cli-source', 'config.json')
    ))).toBe(true);
    const persisted = JSON.parse(await readFile(fake.state, 'utf8')) as Record<string, unknown>;
    expect(persisted.resumeDeveloperInstructions).toContain('persistent Codex worker task');
    expect(persisted.resumeDeveloperInstructions).not.toContain('lark-channel-bridge 运行约定');
  });

  it('does not persist the observed runtime model unless the caller explicitly overrides it', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-D3FA17',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });

    const created = await controller.create({ title: 'Default model', cwd: fake.dir });
    expect('output' in created).toBe(false);
    if ('output' in created) throw new Error('unexpected execution result');
    expect(created.model).toBeUndefined();

    const sent = await controller.send(created.handle, { message: 'use profile default' });
    expect(sent.task.model).toBeUndefined();
    expect((await registry.get(created.handle))?.model).toBeUndefined();

    const pinned = await controller.send(created.handle, {
      message: 'pin the next model',
      model: 'gpt-pinned',
    });
    expect(pinned.task.model).toBe('gpt-pinned');
    expect((await registry.get(created.handle))?.model).toBe('gpt-pinned');
  });

  it('keeps a failed thread naming operation discoverable in the registry', async () => {
    const fake = await createFakeAppServer({ failThreadName: true });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-FA17ED',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });

    await expect(controller.create({ title: 'Recoverable worker', cwd: fake.dir })).rejects.toThrow(
      /T-FA17ED/,
    );
    const recovered = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry: new CodexTaskRegistry(join(fake.dir, 'codex-tasks.json')),
      sandbox: 'workspace-write',
    });
    await expect(recovered.list()).resolves.toEqual([
      expect.objectContaining({
        handle: 'T-FA17ED',
        threadId: 'thread-worker',
        status: 'failed',
      }),
    ]);
  });

  it('records the durable thread id when registry import fails after thread creation', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const baseRegistry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-1A2B3C',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry: new FailImportRegistry(baseRegistry),
      sandbox: 'workspace-write',
    });

    await expect(controller.create({ title: 'Import recovery', cwd: fake.dir })).rejects.toThrow(
      /T-1A2B3C.*thread-worker/,
    );
    await expect(baseRegistry.get('T-1A2B3C')).resolves.toMatchObject({
      status: 'reconcile',
      threadId: 'thread-worker',
      reconciliation: {
        desiredStatus: 'failed',
        threadId: 'thread-worker',
        error: 'simulated thread import failure',
      },
    });
  });

  it('returns a completed turn with an explicit sync warning when final registry persistence fails', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const baseRegistry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-5A17ED',
    );
    const registry = new FailCompletedUpdateRegistry(baseRegistry);
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });
    const created = await controller.create({ title: 'Durable send', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');

    await expect(controller.send(created.handle, { message: 'do not retry me' })).resolves.toMatchObject({
      task: { handle: created.handle, status: 'completed' },
      output: 'worker-ok: do not retry me',
      terminationReason: 'normal',
      registrySync: 'pending',
      registryError: 'simulated completed update failure',
    });
    await expect(baseRegistry.get(created.handle)).resolves.toMatchObject({
      status: 'reconcile',
      threadId: 'thread-worker',
      reconciliation: {
        desiredStatus: 'completed',
        lastTurnId: 'turn-1',
        lastResult: 'worker-ok: do not retry me',
      },
    });
    const recovered = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry: new CodexTaskRegistry(join(fake.dir, 'codex-tasks.json')),
      sandbox: 'workspace-write',
    });
    await expect(recovered.list()).resolves.toEqual([
      expect.objectContaining({
        status: 'completed',
        lastTurnId: 'turn-1',
        lastResult: 'worker-ok: do not retry me',
      }),
    ]);
  });
});

class FailCompletedUpdateRegistry extends CodexTaskRegistry {
  constructor(private readonly delegate: CodexTaskRegistry) {
    super('/unused');
  }

  override list() {
    return this.delegate.list();
  }

  override get(handle: string) {
    return this.delegate.get(handle);
  }

  override reserve(input: Parameters<CodexTaskRegistry['reserve']>[0]) {
    return this.delegate.reserve(input);
  }

  override importThread(handle: string, threadId: string) {
    return this.delegate.importThread(handle, threadId);
  }

  override markReconcile(
    handle: string,
    input: Parameters<CodexTaskRegistry['markReconcile']>[1],
  ) {
    return this.delegate.markReconcile(handle, input);
  }

  override reconcile(handle?: string) {
    return this.delegate.reconcile(handle);
  }

  override register(input: Parameters<CodexTaskRegistry['register']>[0]) {
    return this.delegate.register(input);
  }

  override update(
    handle: string,
    input: Parameters<CodexTaskRegistry['update']>[1],
  ): ReturnType<CodexTaskRegistry['update']> {
    if (input.status === 'completed') {
      return Promise.reject(new Error('simulated completed update failure'));
    }
    return this.delegate.update(handle, input);
  }
}

class FailImportRegistry extends FailCompletedUpdateRegistry {
  override importThread(): ReturnType<CodexTaskRegistry['importThread']> {
    return Promise.reject(new Error('simulated thread import failure'));
  }
}

async function createFakeAppServer(options: { failThreadName?: boolean } = {}): Promise<{
  dir: string;
  binary: string;
  invocations: string;
  environments: string;
  state: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-controller-'));
  const binary = join(dir, 'fake-codex.mjs');
  const state = join(dir, 'state.json');
  const invocations = join(dir, 'invocations.json');
  const environments = join(dir, 'environments.json');
  const source = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = ${JSON.stringify(state)};
const invocationsPath = ${JSON.stringify(invocations)};
const environmentsPath = ${JSON.stringify(environments)};
const failThreadName = ${JSON.stringify(options.failThreadName === true)};
const invocations = existsSync(invocationsPath) ? JSON.parse(readFileSync(invocationsPath, 'utf8')) : [];
invocations.push(process.argv.slice(2));
writeFileSync(invocationsPath, JSON.stringify(invocations));
const environments = existsSync(environmentsPath) ? JSON.parse(readFileSync(environmentsPath, 'utf8')) : [];
environments.push({
  LARK_CHANNEL_BRIDGE_CONFIG: process.env.LARK_CHANNEL_BRIDGE_CONFIG,
  LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG
});
writeFileSync(environmentsPath, JSON.stringify(environments));
if (process.argv[2] === 'features' && process.argv[3] === 'list') {
  process.stdout.write('apps stable true\\ncomputer_use stable true\\n');
  process.exit(0);
}

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
    if (failThreadName) {
      send({ id: message.id, error: { code: -32000, message: 'simulated thread/name/set failure' } });
      return;
    }
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
  return { dir, binary, invocations, environments, state };
}
