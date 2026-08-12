import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeAppServerChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('Codex app-server response races', () => {
  it('emits one tool result when server resolution races with the answer write', async () => {
    const child = fakeRacingAppServerChild('answer-resolution');
    spawnMock.spawnProcess.mockReturnValue(child);
    const controller = new AbortController();
    const run = new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
      ignoreRules: false,
    }).run({
      runId: 'run-race',
      prompt: '继续',
      cwd: '/tmp',
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          return { answers: [{ questionId: 'confirm', value: '继续' }] };
        },
      },
    });

    const events = await collectEvents(run.events);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      {
        type: 'tool_result',
        id: 'request-race',
        output: '用户已提交回答',
        isError: false,
      },
    ]);
  });

  it('emits only interrupted when turn completion races with the interrupt write', async () => {
    const child = fakeRacingAppServerChild('interrupt-completion');
    spawnMock.spawnProcess.mockReturnValue(child);
    const controller = new AbortController();
    const run = new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
      ignoreRules: false,
    }).run({
      runId: 'run-interrupt-race',
      prompt: '停止',
      cwd: '/tmp',
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          throw new Error('此场景不应请求用户输入');
        },
      },
    });

    let ready!: () => void;
    const readyEvent = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const eventsPromise = collectEvents(run.events, (event) => {
      if (event.type === 'thinking') ready();
    });
    await readyEvent;
    await run.stop();

    const terminalEvents = (await eventsPromise).filter(
      (event) => event.type === 'done' || event.type === 'error',
    );
    expect(terminalEvents).toEqual([{
      type: 'done',
      threadId: 'thread-race',
      terminationReason: 'interrupted',
    }]);
  });
});

type RaceScenario = 'answer-resolution' | 'interrupt-completion';

function fakeRacingAppServerChild(scenario: RaceScenario): FakeAppServerChild {
  const child = new EventEmitter() as FakeAppServerChild;
  child.pid = 4343;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const send = (message: Record<string, unknown>): void => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      const method = typeof message.method === 'string' ? message.method : undefined;
      if (method === 'initialize') {
        callback();
        send({
          id: message.id,
          result: { userAgent: 'lark-channel-bridge/0.107.0 (Linux; x86_64)' },
        });
        return;
      }
      if (method === 'initialized') {
        callback();
        return;
      }
      if (method === 'thread/start') {
        callback();
        send({ id: message.id, result: { thread: { id: 'thread-race' } } });
        return;
      }
      if (method === 'turn/start') {
        callback();
        send({ id: message.id, result: { turn: { id: 'turn-race' } } });
        if (scenario === 'interrupt-completion') {
          setImmediate(() => {
            send({
              method: 'item/reasoning/summaryTextDelta',
              params: {
                threadId: 'thread-race',
                turnId: 'turn-race',
                itemId: 'reasoning-race',
                summaryIndex: 1,
                delta: '已进入运行状态',
              },
            });
          });
          return;
        }
        setImmediate(() => {
          send({
            method: 'item/tool/requestUserInput',
            id: 'server-request-race',
            params: {
              threadId: 'thread-race',
              turnId: 'turn-race',
              itemId: 'request-race',
              questions: [
                {
                  id: 'confirm',
                  header: '确认',
                  question: '是否继续？',
                  options: [{ label: '继续', description: '继续执行' }],
                },
              ],
            },
          });
        });
        return;
      }
      if (method === 'turn/interrupt' && scenario === 'interrupt-completion') {
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'completed' } },
        });
        setImmediate(callback);
        return;
      }
      if (message.id === 'server-request-race' && method === undefined) {
        // Resolve the request from the server while the client's stdin write
        // callback is deliberately pending. Only the submitted result is valid.
        send({
          method: 'serverRequest/resolved',
          params: { threadId: 'thread-race', requestId: 'server-request-race' },
        });
        setImmediate(() => {
          callback();
          setImmediate(() => {
            send({
              method: 'turn/completed',
              params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'completed' } },
            });
          });
        });
        return;
      }
      callback();
    },
  });
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  });
  return child;
}

async function collectEvents(
  events: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    onEvent?.(event);
  }
  return collected;
}
