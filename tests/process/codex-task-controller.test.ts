import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTaskController, finalAgentMessages } from '../../src/codex-task/controller';
import { CodexTaskBusyError, CodexTaskRegistry } from '../../src/codex-task/registry';
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
      status: 'pending',
    });
    expect(created.threadId).toBeUndefined();
    await expect(controller.read(created.handle)).rejects.toThrow(/pending.*first message/i);

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
    expect(persisted.startDeveloperInstructions).toContain('persistent Codex worker task');
    expect(persisted.startDeveloperInstructions).not.toContain('lark-channel-bridge 运行约定');
  });

  it('materializes create --message in the same App Server lifecycle', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-C0DE01',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });

    const created = await controller.create({
      title: 'Immediate worker',
      cwd: fake.dir,
      message: 'bootstrap',
    });
    if (!('output' in created)) throw new Error('expected execution result');
    expect(created).toMatchObject({
      task: { handle: 'T-C0DE01', threadId: 'thread-worker', status: 'completed' },
      output: 'worker-ok: bootstrap',
      terminationReason: 'normal',
    });
    await expect(controller.read(created.task.handle)).resolves.toMatchObject({
      thread: { id: 'thread-worker', name: 'Immediate worker' },
    });
  });

  it('includes the reserved handle when create --message fails', async () => {
    const fake = await createFakeAppServer({ rejectTurnStart: true });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-BAD001',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });

    await expect(controller.create({
      title: 'Failed immediate worker',
      cwd: fake.dir,
      message: 'bootstrap',
    })).rejects.toThrow(/T-BAD001.*first turn/i);
    await expect(registry.get('T-BAD001')).resolves.toMatchObject({ status: 'failed' });
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

  it('keeps a successfully materialized task usable when thread naming fails', async () => {
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

    const created = await controller.create({ title: 'Recoverable worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');
    const sent = await controller.send(created.handle, { message: 'materialize me' });
    expect(sent).toMatchObject({
      task: { handle: 'T-FA17ED', threadId: 'thread-worker', status: 'completed' },
      output: 'worker-ok: materialize me',
    });
    await expect(controller.list()).resolves.toEqual([sent.task]);
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

    const created = await controller.create({ title: 'Import recovery', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');
    await expect(controller.send(created.handle, { message: 'materialize' })).rejects.toThrow(
      /simulated thread import failure/,
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

  it('recovers a durable candidate but fails closed when the first-turn outcome is ambiguous', async () => {
    const fake = await createFakeAppServer({ dropTurnStartResponse: true });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-A8B190',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });
    const created = await controller.create({ title: 'Ambiguous worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');

    await expect(controller.send(created.handle, { message: 'run exactly once' })).rejects.toThrow();
    await expect(registry.get(created.handle)).resolves.toMatchObject({
      status: 'failed',
      candidateThreadId: 'thread-worker',
    });

    await expect(controller.send(created.handle, { message: 'must not run yet' })).rejects.toThrow(
      /outcome.*ambiguous/i,
    );
    await expect(registry.get(created.handle)).resolves.toMatchObject({
      status: 'failed',
      threadId: 'thread-worker',
    });
    await expect(registry.get(created.handle)).resolves.not.toHaveProperty('candidateThreadId');
    const persisted = JSON.parse(await readFile(fake.state, 'utf8')) as { turns?: unknown[] };
    expect(persisted.turns).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain('must not run yet');
  });

  it('clears an explicitly missing candidate before retrying materialization', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-CA11D0',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });
    const created = await registry.reserve({ title: 'Missing candidate', cwd: fake.dir });
    await registry.update(created.handle, { status: 'failed' });
    await registry.setThreadCandidate(created.handle, 'thread-missing');

    await expect(controller.send(created.handle, { message: 'safe retry' })).resolves.toMatchObject({
      task: { status: 'completed', threadId: 'thread-worker' },
      output: 'worker-ok: safe retry',
    });
    await expect(registry.get(created.handle)).resolves.not.toHaveProperty('candidateThreadId');
  });

  it('keeps a candidate and fails closed on a non-not-found read error', async () => {
    const fake = await createFakeAppServer({
      threadReadError: { code: -32600, message: 'temporary registry backend failure' },
    });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-CA11D1',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });
    const created = await registry.reserve({ title: 'Unreadable candidate', cwd: fake.dir });
    await registry.update(created.handle, { status: 'failed' });
    await registry.setThreadCandidate(created.handle, 'thread-unknown');

    await expect(controller.send(created.handle, { message: 'do not duplicate' })).rejects.toThrow(
      /unresolved thread candidate/i,
    );
    await expect(registry.get(created.handle)).resolves.toMatchObject({
      candidateThreadId: 'thread-unknown',
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

  it('marks a silent turn as timeout and releases the task execution lock', async () => {
    const fake = await createFakeAppServer({ neverComplete: true });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-71AE00',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
      turnIdleTimeoutMs: 100,
      stopGraceMs: 50,
    });
    const created = await controller.create({ title: 'Silent worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');

    await expect(controller.send(created.handle, { message: 'stay silent' })).resolves.toMatchObject({
      task: { status: 'timeout', threadId: 'thread-worker' },
      terminationReason: 'timeout',
    });
    await expect(controller.send(created.handle, { message: 'try again' })).resolves.toMatchObject({
      task: { status: 'timeout' },
      terminationReason: 'timeout',
    });
  });

  it('keeps an active turn alive when raw command progress continues', async () => {
    const fake = await createFakeAppServer({ turnDelayMs: 300, progressEveryMs: 25 });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-AC7100',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
      turnIdleTimeoutMs: 100,
      stopGraceMs: 50,
    });
    const created = await controller.create({ title: 'Active worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');

    await expect(controller.send(created.handle, { message: 'long build' })).resolves.toMatchObject({
      task: { status: 'completed' },
      terminationReason: 'normal',
      output: 'worker-ok: long build',
    });
  });

  it('uses AbortSignal to interrupt a turn and release the execution lock', async () => {
    const fake = await createFakeAppServer({ turnDelayMs: 1_000 });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-AB0710',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
      turnIdleTimeoutMs: 2_000,
      stopGraceMs: 50,
    });
    const created = await controller.create({ title: 'Abortable worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');
    const abort = new AbortController();
    const sent = controller.send(created.handle, {
      message: 'wait for cancellation',
      signal: abort.signal,
    });
    await waitForTaskThread(registry, created.handle);
    abort.abort();

    await expect(sent).resolves.toMatchObject({
      task: { status: 'interrupted', threadId: 'thread-worker' },
      terminationReason: 'interrupted',
    });
    await expect(registry.withTaskLock(created.handle, async () => 'released')).resolves.toBe('released');
  });

  it('rejects a concurrent send with a domain error instead of using stale task state', async () => {
    const fake = await createFakeAppServer({ turnDelayMs: 200 });
    cleanup.push(fake.dir);
    const registry = new CodexTaskRegistry(
      join(fake.dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-B05E00',
    );
    const controller = new CodexTaskController({
      binary: fake.binary,
      profileStateDir: fake.dir,
      registry,
      sandbox: 'workspace-write',
    });
    const created = await controller.create({ title: 'Busy worker', cwd: fake.dir });
    if ('output' in created) throw new Error('unexpected execution result');

    const first = controller.send(created.handle, { message: 'first', model: 'gpt-first' });
    await waitForTaskStatus(registry, created.handle, 'running');
    const second = controller.send(created.handle, { message: 'second', model: 'gpt-stale' });
    await expect(second).rejects.toBeInstanceOf(CodexTaskBusyError);
    await expect(first).resolves.toMatchObject({
      task: { status: 'completed', model: 'gpt-first' },
      output: 'worker-ok: first',
    });
    await expect(registry.get(created.handle)).resolves.toMatchObject({ model: 'gpt-first' });
  });
});

class FailCompletedUpdateRegistry extends CodexTaskRegistry {
  constructor(private readonly delegate: CodexTaskRegistry) {
    super('/unused');
  }

  override withTaskLock<T>(handle: string, fn: () => Promise<T>) {
    return this.delegate.withTaskLock(handle, fn);
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

  override setThreadCandidate(handle: string, threadId: string) {
    return this.delegate.setThreadCandidate(handle, threadId);
  }

  override clearThreadCandidate(handle: string, threadId: string) {
    return this.delegate.clearThreadCandidate(handle, threadId);
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

async function createFakeAppServer(options: {
  dropTurnStartResponse?: boolean;
  failThreadName?: boolean;
  neverComplete?: boolean;
  progressEveryMs?: number;
  rejectTurnStart?: boolean;
  threadReadError?: { code: number; message: string };
  turnDelayMs?: number;
} = {}): Promise<{
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
const dropTurnStartResponse = ${JSON.stringify(options.dropTurnStartResponse === true)};
const failThreadName = ${JSON.stringify(options.failThreadName === true)};
const neverComplete = ${JSON.stringify(options.neverComplete === true)};
const progressEveryMs = ${JSON.stringify(options.progressEveryMs ?? 0)};
const rejectTurnStart = ${JSON.stringify(options.rejectTurnStart === true)};
const threadReadError = ${JSON.stringify(options.threadReadError)};
const turnDelayMs = ${JSON.stringify(options.turnDelayMs ?? 10)};
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
let loadedCwd;
let loadedModel;
let loadedDeveloperInstructions;
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
    loadedCwd = message.params.cwd;
    loadedModel = message.params.model;
    loadedDeveloperInstructions = message.params.developerInstructions;
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
    if (!load()) {
      send({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id' } });
      return;
    }
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
    loadedCwd = message.params.cwd;
    loadedModel = message.params.model;
    loadedDeveloperInstructions = message.params.developerInstructions;
    save({
      ...current,
      resumeDeveloperInstructions: message.params.developerInstructions,
      resumeExcludeTurns: message.params.excludeTurns,
    });
    send({ id: message.id, result: {
      thread: current,
      cwd: message.params.cwd,
      model: message.params.model ?? 'gpt-test',
      modelProvider: 'fake'
    }});
    return;
  }
  if (message.method === 'thread/read') {
    if (threadReadError) {
      send({ id: message.id, error: threadReadError });
      return;
    }
    const current = load();
    if (!current || current.id !== message.params.threadId) {
      send({
        id: message.id,
        error: { code: -32600, message: 'thread not loaded: ' + message.params.threadId }
      });
      return;
    }
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
    const existing = load();
    const current = existing ?? {
      id: loadedThread,
      cwd: loadedCwd ?? process.cwd(),
      model: loadedModel,
      startDeveloperInstructions: loadedDeveloperInstructions,
      turns: [],
    };
    const turnId = 'turn-' + ((current.turns?.length ?? 0) + 1);
    const text = 'worker-ok: ' + message.params.input[0].text;
    if (rejectTurnStart) {
      send({ id: message.id, error: { code: -32000, message: 'simulated turn/start rejection' } });
      return;
    }
    // The fake models Codex durability: thread/start alone is in-memory; the
    // first turn/start materializes the thread before naming or process exit.
    save(current);
    if (dropTurnStartResponse) {
      save({ ...current, turns: [...(current.turns ?? []), {
        id: turnId, status: 'completed', items: [{ id: 'msg-1', type: 'agentMessage', text }]
      }] });
      process.exit(1);
    }
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (neverComplete) return;
    const progressTimer = progressEveryMs > 0 ? setInterval(() => {
      send({ method: 'item/commandExecution/outputDelta', params: {
        threadId: loadedThread, turnId, itemId: 'command-1', delta: 'still working'
      }});
    }, progressEveryMs) : undefined;
    setTimeout(() => {
      if (progressTimer) clearInterval(progressTimer);
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
      const persisted = load();
      save({ ...persisted, turns: [...(persisted.turns ?? []), {
        id: turnId, status: 'completed', items: [{ id: 'msg-1', type: 'agentMessage', text }]
      }] });
      send({ method: 'turn/completed', params: {
        threadId: loadedThread, turn: { id: turnId, status: 'completed', items: [] }
      }});
    }, turnDelayMs);
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: {
      threadId: loadedThread, turn: { id: message.params.turnId, status: 'interrupted', items: [] }
    }});
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

async function waitForTaskStatus(
  registry: CodexTaskRegistry,
  handle: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await registry.get(handle))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${handle} to reach ${status}`);
}

async function waitForTaskThread(registry: CodexTaskRegistry, handle: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await registry.get(handle))?.threadId) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${handle} to import its thread`);
}
