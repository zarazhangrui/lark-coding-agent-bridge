import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, CodexAppServerRun } from '../../src/agent/codex/app-server-client.js';
import {
  APP_SERVER_PROCESS_GROUP_ENABLED,
  signalAppServerProcess,
  spawnCodexAppServer,
  terminateAndReapAppServer,
} from '../../src/agent/codex/app-server-process.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

const cleanups: Array<() => Promise<void>> = [];
const PRIME_PROMPT_FOR_TEST = 'Reply with READY. Do not call tools, MCP servers, or shell commands.';

// These process-contract tests spawn and reap detached process groups. Under
// the full 100+ file suite, macOS scheduling can legitimately exceed Vitest's
// 5s unit-test default even though the protocol deadlines remain much lower.
vi.setConfig({ testTimeout: 15_000 });

describe('CodexAppServerClient shared process contract', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('preserves bridge environment inheritance for app-server shell children', () => {
    let receivedArgs: readonly string[] | undefined;
    const child = {
      pid: 12345,
      stdin: {},
      stdout: {},
      stderr: {},
    } as never;
    spawnCodexAppServer({
      binary: 'codex',
      env: {},
      spawn: (_command, args) => {
        receivedArgs = args;
        return child;
      },
    });
    expect(receivedArgs).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'shell_environment_policy.inherit="all"',
    ]);
  });

  it('reaps a child stuck in initialize without waiting for the RPC timeout', async () => {
    const fake = await createFakeAppServer({ hangInitialize: true });
    const client = new CodexAppServerClient({
      binary: fake.path,
      cwd: fake.dir,
      timeoutMs: 120_000,
      stopGraceMs: 40,
    });
    const preparing = client.prepare().then(() => undefined, (error: unknown) => error);
    await waitForRecord(fake.recordPath, 'initialize');
    const startedAt = Date.now();
    await client.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await preparing).toBeInstanceOf(Error);
  });

  it('primes one hidden ephemeral read-only turn per generation', async () => {
    const fake = await createFakeAppServer({ delayed: true });
    const client = new CodexAppServerClient({
      binary: fake.path,
      cwd: fake.dir,
      timeoutMs: 2_000,
      stopGraceMs: 100,
    });
    await Promise.all([
      client.prime(fake.dir, 'Use the normal bridge instructions.'),
      client.prime(fake.dir, 'A concurrent caller must share this prime.'),
    ]);
    await client.prime(fake.dir);
    expect(client.activeTurnCount).toBe(0);
    expect(client.trackedThreadCount).toBe(0);
    expect(client.trackedTurnCount).toBe(0);
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/initialize\n/g)?.length).toBe(1);
    expect(record.match(/thread\/start\n/g)?.length).toBe(1);
    expect(record.match(/turn\/start\n/g)?.length).toBe(1);
    expect(record.match(/thread\/backgroundTerminals\/clean\n/g)?.length).toBe(1);
    expect(record).toContain('"ephemeral":true');
    expect(record).toContain('"dynamicTools":[]');
    expect(record).toContain('"sandbox":"read-only"');
    expect(record).toContain('{"type":"readOnly","networkAccess":false}');
    expect(record).toContain(PRIME_PROMPT_FOR_TEST);
    await client.shutdown();
  });

  it('re-primes a fresh generation after a hidden prime turn crashes', async () => {
    const fake = await createFakeAppServer({ crashOnce: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    await expect(client.prime(fake.dir)).rejects.toThrow('prime warmup failed');
    await client.prime(fake.dir);
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/initialize\n/g)?.length).toBe(2);
    expect(record.match(/thread\/start\n/g)?.length).toBe(2);
    expect(record.match(/turn\/start\n/g)?.length).toBe(2);
    expect(record.match(/Reply with READY\. Do not call tools, MCP servers, or shell commands\.\n/g)?.length).toBe(2);
    expect(record.match(/thread\/backgroundTerminals\/clean\n/g)?.length).toBe(1);
    await client.shutdown();
  });

  it('signals the detached POSIX process group before falling back to the child', () => {
    if (!APP_SERVER_PROCESS_GROUP_ENABLED) return;
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let directSignal = false;
    const child = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: () => { directSignal = true; return true; },
    } as never;
    expect(signalAppServerProcess(child, 'SIGTERM', (pid, signal) => groupSignals.push([pid, signal]))).toBe(true);
    expect(groupSignals).toEqual([[-12345, 'SIGTERM']]);
    expect(directSignal).toBe(false);
  });

  it('signals descendants even when the detached leader already exited', async () => {
    if (!APP_SERVER_PROCESS_GROUP_ENABLED) return;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const child = {
      pid: 23456,
      exitCode: 0,
      signalCode: null,
      stdin: { destroyed: true, writableEnded: true },
      kill: () => false,
    } as never;
    await terminateAndReapAppServer(child, Promise.resolve(), {
      eofGraceMs: 0,
      terminateGraceMs: 0,
      killGraceMs: 0,
      signalProcess: (pid, signal) => signals.push([pid, signal]),
    });
    expect(signals).toEqual([
      [-23456, 'SIGTERM'],
      [-23456, 'SIGKILL'],
    ]);
  });

  it('initializes once and routes two concurrent topics without cross-streaming', async () => {
    const fake = await createFakeAppServer();
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const first = client.startRun({
      runId: 'run-a',
      prompt: 'topic-a',
      cwd: fake.dir,
      sandbox: 'workspace-write',
      additionalContext: {
        topic: { kind: 'untrusted', value: 'topic context' },
        card: { kind: 'application', value: 'interactive card' },
      },
    });
    const second = client.startRun({ runId: 'run-b', prompt: 'topic-b', cwd: fake.dir, sandbox: 'workspace-write' });
    const [firstEvents, secondEvents] = await Promise.all([collect(first), collect(second)]);

    const firstThread = firstEvents.find((event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system')?.threadId;
    expect(firstEvents).toContainEqual({ type: 'final_text', content: 'answer:topic-a' });
    const secondThread = secondEvents.find((event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system')?.threadId;
    expect(firstThread).toBeTruthy();
    expect(secondThread).toBeTruthy();
    expect(firstThread).not.toBe(secondThread);
    expect(secondEvents).toContainEqual({ type: 'final_text', content: 'answer:topic-b' });
    expect(firstEvents.some((event) => event.type === 'final_text' && event.content === 'answer:topic-b')).toBe(false);
    expect(secondEvents.some((event) => event.type === 'final_text' && event.content === 'answer:topic-a')).toBe(false);
    expect(await readFile(fake.recordPath, 'utf8')).toMatch(/initialize\n/);
    expect((await readFile(fake.recordPath, 'utf8')).match(/initialize\n/g)?.length).toBe(1);
    expect(await readFile(fake.recordPath, 'utf8')).toContain('"networkAccess":false');
    expect(await readFile(fake.recordPath, 'utf8')).toContain(
      `{"type":"workspaceWrite","writableRoots":["${fake.dir}"],"networkAccess":false}`,
    );
    expect(await readFile(fake.recordPath, 'utf8')).toContain(
      '{"topic":{"kind":"untrusted","value":"topic context"},"card":{"kind":"application","value":"interactive card"}}',
    );
    await client.shutdown();
  });

  it('reuses the same child and loaded thread for consecutive turns', async () => {
    const fake = await createFakeAppServer();
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const first = await collect(client.startRun({ runId: 'run-1', prompt: 'one', cwd: fake.dir }));
    const threadId = first.find((event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system')?.threadId;
    expect(threadId).toBe('thread-1');
    const second = await collect(client.startRun({ runId: 'run-2', prompt: 'two', cwd: fake.dir, threadId }));
    expect(second).toContainEqual({ type: 'final_text', content: 'answer:two' });
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/initialize\n/g)?.length).toBe(1);
    expect(record.match(/thread\/start\n/g)?.length).toBe(1);
    expect(record.match(/thread\/resume\n/g)?.length ?? 0).toBe(0);
    expect(record.match(/turn\/start\n/g)?.length).toBe(2);
    expect(record.match(/thread\/backgroundTerminals\/clean\n/g)?.length).toBe(2);
    expect(record).toContain('"threadSource":"user"');
    expect(record).not.toContain('"excludeTurns"');
    await client.shutdown();
  });

  it('cleans background terminals before publishing a failed turn terminal', async () => {
    const fake = await createFakeAppServer({ failed: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const events = await collect(client.startRun({ runId: 'run-failed', prompt: 'fail-me', cwd: fake.dir }));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/thread\/backgroundTerminals\/clean\n/g)?.length).toBe(1);
    expect(record.indexOf('thread/backgroundTerminals/clean\n')).toBeLessThan(record.indexOf('clean-response\n'));
    await client.shutdown();
  });

  it('filters global app-server notification noise while preserving unknown run items', async () => {
    const fake = await createFakeAppServer({ globalNoise: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const run = client.startRun({ runId: 'run-noise', prompt: 'noise', cwd: fake.dir }) as CodexAppServerRun;
    const events = await collect(run);
    expect(events).toContainEqual({ type: 'final_text', content: 'answer:noise' });
    expect(run.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
    await client.shutdown();
  });

  it('interrupts only the selected virtual turn', async () => {
    const fake = await createFakeAppServer({ delayed: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000, stopGraceMs: 100 });
    const first = client.startRun({ runId: 'run-stop', prompt: 'stop-me', cwd: fake.dir });
    const second = client.startRun({ runId: 'run-keep', prompt: 'keep-me', cwd: fake.dir });
    const firstSystem = await waitForEvent(first, (event) => event.type === 'system');
    const secondSystem = await waitForEvent(second, (event) => event.type === 'system');
    expect(firstSystem).toMatchObject({ type: 'system' });
    expect(secondSystem).toMatchObject({ type: 'system' });
    await first.stop();
    const [firstEvents, secondEvents] = await Promise.all([collect(first), collect(second)]);
    expect(firstEvents.find((event) => event.type === 'done')).toMatchObject({ terminationReason: 'interrupted' });
    expect(secondEvents).toContainEqual({ type: 'final_text', content: 'answer:keep-me' });
    expect(secondEvents.find((event) => event.type === 'done')).toMatchObject({ terminationReason: 'normal' });
    await client.shutdown();
  });

  it('keeps an immediate same-thread follow-up routed while the stopped turn retires', async () => {
    const fake = await createFakeAppServer({ delayed: true });
    const client = new CodexAppServerClient({
      binary: fake.path,
      cwd: fake.dir,
      timeoutMs: 2_000,
      stopGraceMs: 1_000,
    });
    const first = client.startRun({ runId: 'run-old', prompt: 'old', cwd: fake.dir });
    await waitForEvent(first, (event) => event.type === 'system');
    const firstStop = first.stop();
    const second = client.startRun({
      runId: 'run-follow-up',
      prompt: 'follow-up',
      cwd: fake.dir,
      threadId: 'thread-1',
    });
    const [firstEvents, secondEvents] = await Promise.all([
      collect(first),
      collect(second),
      firstStop.then(() => [] as AgentEvent[]),
    ]);
    expect(firstEvents.find((event) => event.type === 'done')).toMatchObject({ terminationReason: 'interrupted' });
    expect(secondEvents).toContainEqual({ type: 'final_text', content: 'answer:follow-up' });
    expect(secondEvents.find((event) => event.type === 'done')).toMatchObject({ terminationReason: 'normal' });
    expect(client.activeTurnCount).toBe(0);
    expect(client.trackedThreadCount).toBe(0);
    expect(client.trackedTurnCount).toBe(0);
    await client.shutdown();
  });

  it('waits for thread-wide cleanup before starting a same-thread follow-up', async () => {
    const fake = await createFakeAppServer({ delayed: true, cleanDelayMs: 200 });
    const client = new CodexAppServerClient({
      binary: fake.path,
      cwd: fake.dir,
      timeoutMs: 2_000,
      stopGraceMs: 1_000,
    });
    const first = client.startRun({ runId: 'run-clean-old', prompt: 'old', cwd: fake.dir });
    await waitForEvent(first, (event) => event.type === 'system');
    const stop = first.stop();
    const second = client.startRun({
      runId: 'run-clean-follow-up',
      prompt: 'follow-up',
      cwd: fake.dir,
      threadId: 'thread-1',
    });
    const [, secondEvents] = await Promise.all([collect(first), collect(second), stop]);
    expect(secondEvents).toContainEqual({ type: 'final_text', content: 'answer:follow-up' });
    const record = await readFile(fake.recordPath, 'utf8');
    const firstClean = record.indexOf('clean-response\n');
    const firstTurn = record.indexOf('turn/start\n');
    const secondTurn = record.indexOf('turn/start\n', firstTurn + 'turn/start\n'.length);
    expect(firstClean).toBeGreaterThan(firstTurn);
    expect(secondTurn).toBeGreaterThan(firstClean);
    await client.shutdown();
  });

  it('fails safely when background-terminal cleanup is rejected', async () => {
    const fake = await createFakeAppServer({ cleanFails: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const run = client.startRun({ runId: 'run-clean-fail', prompt: 'cleanup-me', cwd: fake.dir });
    await waitForEvent(run, (event) => event.type === 'system');
    await run.stop();
    const events = await collect(run);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'done' && event.terminationReason === 'interrupted')).toBe(false);
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record).toContain('thread/backgroundTerminals/clean\n');
    expect(record).toContain('{"threadId":"thread-1"}');
    expect(client.pid).toBeUndefined();
    await client.shutdown();
  });

  it('retires the generation when background-terminal cleanup times out', async () => {
    const fake = await createFakeAppServer({ cleanNoResponse: true });
    const client = new CodexAppServerClient({
      binary: fake.path,
      cwd: fake.dir,
      timeoutMs: 2_000,
      stopGraceMs: 40,
    });
    const events = await collect(client.startRun({ runId: 'run-clean-timeout', prompt: 'cleanup-timeout', cwd: fake.dir }));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(client.pid).toBeUndefined();
    await client.shutdown();
  });

  it('cleans routing maps when stop wins a delayed turn/start response race', async () => {
    const fake = await createFakeAppServer({ delayedTurnResponse: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000, stopGraceMs: 20 });
    const run = client.startRun({ runId: 'run-race', prompt: 'race', cwd: fake.dir });
    await waitForRecord(fake.recordPath, 'turn/start');
    await run.stop();
    const events = await collect(run);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(client.pid).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(client.activeTurnCount).toBe(0);
    expect(client.trackedThreadCount).toBe(0);
    expect(client.trackedTurnCount).toBe(0);
    await client.shutdown();
  });

  it('does not spawn a replacement until the stopped generation has been reaped', async () => {
    const fake = await createFakeAppServer({ delayedTurnResponse: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000, stopGraceMs: 20 });
    const first = client.startRun({ runId: 'run-reap-old', prompt: 'old', cwd: fake.dir });
    await waitForRecord(fake.recordPath, 'turn/start');
    await first.stop();
    const recordBeforeReplacement = await readFile(fake.recordPath, 'utf8');
    expect(recordBeforeReplacement.trimEnd().endsWith('sigterm')).toBe(true);
    const replacement = await collect(client.startRun({
      runId: 'run-reap-new',
      prompt: 'new',
      cwd: fake.dir,
      threadId: 'thread-1',
    }));
    expect(replacement).toContainEqual({ type: 'final_text', content: 'answer:new' });
    expect((await readFile(fake.recordPath, 'utf8')).match(/initialize\n/g)?.length).toBe(2);
    await client.shutdown();
  });

  it('fails active turns on crash and lazily restarts without replaying the prompt', async () => {
    const fake = await createFakeAppServer({ crashOnce: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    const failed = await collect(client.startRun({ runId: 'run-crash', prompt: 'must-run-once', cwd: fake.dir }));
    expect(failed.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('secret');

    const resumed = await collect(client.startRun({
      runId: 'run-resume', prompt: 'after-crash', cwd: fake.dir, threadId: 'thread-1',
    }));
    expect(resumed).toContainEqual({ type: 'final_text', content: 'answer:after-crash' });
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/initialize\n/g)?.length).toBe(2);
    expect(record.match(/must-run-once/g)?.length).toBe(1);
    expect(record.match(/after-crash/g)?.length).toBe(1);
    expect(record.match(/thread\/resume\n/g)?.length).toBe(1);
    await client.shutdown();
  });

  it('serializes concurrent starts while a crashed generation is replaced', async () => {
    const fake = await createFakeAppServer({ crashOnce: true });
    const client = new CodexAppServerClient({ binary: fake.path, cwd: fake.dir, timeoutMs: 2_000 });
    await collect(client.startRun({ runId: 'run-prior-crash', prompt: 'prior', cwd: fake.dir }));
    const [first, second] = await Promise.all([
      collect(client.startRun({ runId: 'run-after-a', prompt: 'after-a', cwd: fake.dir, threadId: 'thread-1' })),
      collect(client.startRun({ runId: 'run-after-b', prompt: 'after-b', cwd: fake.dir, threadId: 'thread-1' })),
    ]);
    expect(first).toContainEqual({ type: 'final_text', content: 'answer:after-a' });
    expect(second).toContainEqual({ type: 'final_text', content: 'answer:after-b' });
    const record = await readFile(fake.recordPath, 'utf8');
    expect(record.match(/initialize\n/g)?.length).toBe(2);
    await client.shutdown();
  });
});

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

async function waitForEvent(run: AgentRun, predicate: (event: AgentEvent) => boolean): Promise<AgentEvent | undefined> {
  for await (const event of run.events) {
    if (predicate(event)) return event;
  }
  return undefined;
}

async function createFakeAppServer(options: {
  delayed?: boolean;
  delayedTurnResponse?: boolean;
  crashOnce?: boolean;
  hangInitialize?: boolean;
  cleanFails?: boolean;
  cleanNoResponse?: boolean;
  cleanDelayMs?: number;
  failed?: boolean;
  globalNoise?: boolean;
} = {}): Promise<{
  dir: string;
  path: string;
  recordPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-client-test-'));
  const path = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const recordPath = join(dir, 'record.log');
  const crashMarker = join(dir, 'crashed');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const record = ${JSON.stringify(recordPath)};
const crashMarker = ${JSON.stringify(crashMarker)};
const delayed = ${JSON.stringify(options.delayed === true)};
const delayedTurnResponse = ${JSON.stringify(options.delayedTurnResponse === true)};
const crashOnce = ${JSON.stringify(options.crashOnce === true)};
const hangInitialize = ${JSON.stringify(options.hangInitialize === true)};
const cleanFails = ${JSON.stringify(options.cleanFails === true)};
const cleanNoResponse = ${JSON.stringify(options.cleanNoResponse === true)};
const cleanDelayMs = ${JSON.stringify(options.cleanDelayMs ?? 0)};
const failed = ${JSON.stringify(options.failed === true)};
const globalNoise = ${JSON.stringify(options.globalNoise === true)};
let threadSeq = 0;
let turnSeq = 0;
const interrupted = new Set();
function log(value) { fs.appendFileSync(record, value + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
log('spawn');
process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });
function later(fn) { setTimeout(fn, delayed ? 120 : 0); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) log(message.method);
  if (message.method === 'initialize') {
    if (hangInitialize) return;
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    log(JSON.stringify(message.params));
    const id = 'thread-' + (++threadSeq);
    send({ id: message.id, result: { thread: { id }, cwd: message.params.cwd } });
    return;
  }
  if (message.method === 'thread/resume') {
    log(JSON.stringify(message.params));
    send({ id: message.id, result: { thread: { id: message.params.threadId }, cwd: message.params.cwd } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq);
    const threadId = message.params.threadId;
    const prompt = message.params.input[0].text;
    log(prompt);
    if (message.params.sandboxPolicy) log(JSON.stringify(message.params.sandboxPolicy));
    if (message.params.additionalContext) log(JSON.stringify(message.params.additionalContext));
    const sendTurnResponse = () => send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (delayedTurnResponse) setTimeout(sendTurnResponse, 160); else sendTurnResponse();
    if (crashOnce && !fs.existsSync(crashMarker)) {
      fs.writeFileSync(crashMarker, '1');
      process.stderr.write('Authorization: Bearer secret\\n');
      setTimeout(() => process.exit(17), 10);
      return;
    }
    if (globalNoise) {
      for (const method of ['mcpServer/changed', 'skills/changed', 'warning', 'account/updated', 'thread/status/changed']) {
        send({ method, params: { threadId, turnId, message: 'global noise' } });
      }
      send({ method: 'item/experimental/changed', params: { threadId, turnId } });
    }
    later(() => {
      if (interrupted.has(turnId)) return;
      send({ method: 'item/started', params: { threadId, turnId, item: { id: 'msg-' + turnId, type: 'agentMessage', phase: 'final_answer', text: '' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-' + turnId, delta: 'answer:' + prompt } });
      send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'msg-' + turnId, type: 'agentMessage', phase: 'final_answer', text: 'answer:' + prompt } } });
      send({ method: 'turn/completed', params: {
        threadId,
        turn: {
          id: turnId,
          status: failed ? 'failed' : 'completed',
          items: [],
          ...(failed ? { error: { message: 'fake turn failed' } } : {}),
        },
      } });
    });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    const threadId = message.params.threadId;
    const turnId = message.params.turnId;
    interrupted.add(turnId);
    later(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', items: [] } } }));
    return;
  }
  if (message.method === 'thread/backgroundTerminals/clean') {
    log(JSON.stringify(message.params));
    if (cleanNoResponse) return;
    const sendCleanResponse = () => {
      log('clean-response');
      if (cleanFails) {
        send({ id: message.id, error: { code: -32000, message: 'background terminal cleanup failed' } });
      } else {
        send({ id: message.id, result: {} });
      }
    };
    if (cleanDelayMs > 0) setTimeout(sendCleanResponse, cleanDelayMs); else sendCleanResponse();
  }
});
`;
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n${script.replace(/\n/g, '\r\n')}`, { mode: 0o755 });
  } else {
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return { dir, path, recordPath };
}

async function waitForRecord(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8').catch(() => '')).includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for fake app-server record: ${needle}`);
}
