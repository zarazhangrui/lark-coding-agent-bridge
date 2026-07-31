import { describe, expect, it } from 'vitest';
import {
  CodexAppServerEventTranslator,
  CodexAppServerJsonRpc,
  CodexAppServerRpcError,
} from '../../../src/agent/codex/app-server-jsonrpc.js';

describe('CodexAppServerJsonRpc', () => {
  it('correlates out-of-order responses by request id', async () => {
    const writes: unknown[] = [];
    const rpc = new CodexAppServerJsonRpc(async (message) => {
      writes.push(message);
    });

    const first = rpc.request('initialize', { capabilities: null });
    const second = rpc.request('thread/start', { cwd: '/repo' });

    expect(writes).toEqual([
      { method: 'initialize', id: 1, params: { capabilities: null } },
      { method: 'thread/start', id: 2, params: { cwd: '/repo' } },
    ]);
    expect(rpc.receive({ id: 2, result: { thread: { id: 'thread-1' } } })).toBeUndefined();
    expect(rpc.receive({ id: 1, result: { userAgent: 'codex' } })).toBeUndefined();

    await expect(first).resolves.toEqual({ userAgent: 'codex' });
    await expect(second).resolves.toEqual({ thread: { id: 'thread-1' } });
  });

  it('surfaces request errors with their code and rejects pending work on close', async () => {
    const rpc = new CodexAppServerJsonRpc(async () => undefined);
    const rejected = rpc.request('thread/resume', { threadId: 'missing' });
    rpc.receive({ id: 1, error: { code: -32000, message: 'thread not found', data: { stale: true } } });

    await expect(rejected).rejects.toMatchObject({
      name: 'CodexAppServerRpcError',
      message: 'thread not found',
      code: -32000,
      data: { stale: true },
    } satisfies Partial<CodexAppServerRpcError>);

    const pending = rpc.request('turn/start', {});
    rpc.fail(new Error('connection lost'));
    await expect(pending).rejects.toThrow('connection lost');
    await expect(rpc.request('thread/start', {})).rejects.toThrow('connection lost');
  });

  it('classifies notifications and server requests without a jsonrpc field', () => {
    const rpc = new CodexAppServerJsonRpc(async () => undefined);

    expect(rpc.receive({ method: 'turn/started', params: { threadId: 't' } })).toEqual({
      kind: 'notification',
      method: 'turn/started',
      params: { threadId: 't' },
    });
    expect(
      rpc.receive({ id: 'server-1', method: 'item/commandExecution/requestApproval', params: {} }),
    ).toEqual({
      kind: 'request',
      id: 'server-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
  });

  it('rejects malformed messages and unknown response ids', () => {
    const rpc = new CodexAppServerJsonRpc(async () => undefined);

    expect(() => rpc.receive('bad')).toThrow(/non-object/);
    expect(() => rpc.receive({ value: 1 })).toThrow(/neither method nor request id/);
    expect(() => rpc.receive({ id: 99, result: {} })).toThrow(/unknown response id/);
  });
});

describe('CodexAppServerEventTranslator', () => {
  it('maps streamed text, reasoning, commands, usage, and a completed turn', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
      }),
    ).toEqual([]);
    expect(
      translator.translate('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        summaryIndex: 0,
        delta: 'checking',
      }),
    ).toEqual([{ type: 'thinking', delta: 'checking' }]);

    expect(
      translator.translate('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          commandActions: [],
          status: 'inProgress',
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'cmd-1',
        name: 'Bash',
        input: { command: 'pwd', cwd: '/repo', commandActions: [] },
      },
    ]);
    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: '/repo\n',
          exitCode: 0,
        },
      }),
    ).toEqual([
      { type: 'tool_result', id: 'cmd-1', output: '/repo\n', isError: false },
    ]);

    translator.translate('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: '' },
    });
    expect(
      translator.translate('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'done',
      }),
    ).toEqual([]);
    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'done!' },
      }),
    ).toEqual([]);

    expect(
      translator.translate('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 10,
            outputTokens: 4,
            cachedInputTokens: 3,
            reasoningOutputTokens: 2,
            totalTokens: 14,
          },
          total: {
            inputTokens: 999,
            outputTokens: 999,
            cachedInputTokens: 999,
            reasoningOutputTokens: 999,
            totalTokens: 1998,
          },
        },
      }),
    ).toEqual([]);
    expect(
      translator.translate('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      }),
    ).toEqual([
      { type: 'final_text', content: 'done!' },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
    expect(translator.translate('turn/completed', {})).toEqual([]);
    expect(translator.finish()).toEqual([]);
  });

  it('uses completed agent messages when no deltas were emitted', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'msg-1', type: 'agentMessage', text: 'whole answer' },
      }),
    ).toEqual([]);
    expect(
      translator.translate('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      }),
    ).toEqual([
      { type: 'final_text', content: 'whole answer' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('does not promote unphased progress text before a tool into the final answer', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'msg-progress', type: 'agentMessage', text: 'I will inspect this.' },
      }),
    ).toEqual([]);
    expect(
      translator.translate('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-after-progress',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          commandActions: [],
          status: 'inProgress',
        },
      }),
    ).toEqual([
      { type: 'text', delta: 'I will inspect this.' },
      {
        type: 'tool_use',
        id: 'cmd-after-progress',
        name: 'Bash',
        input: { command: 'pwd', cwd: '/repo', commandActions: [] },
      },
    ]);
    expect(
      translator.translate('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      }),
    ).toEqual([
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('streams commentary but buffers the final answer until turn completion', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    translator.translate('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '' },
    });
    expect(
      translator.translate('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'commentary-1',
        delta: 'I am checking',
      }),
    ).toEqual([{ type: 'text', delta: 'I am checking' }]);
    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'commentary-1',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'I am checking now.',
        },
      }),
    ).toEqual([{ type: 'text', delta: ' now.' }]);

    translator.translate('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '' },
    });
    expect(
      translator.translate('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'final-1',
        delta: 'Final result.',
      }),
    ).toEqual([]);
    translator.translate('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'final-1',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'Final result.',
      },
    });
    expect(
      translator.translate('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      }),
    ).toEqual([
      { type: 'final_text', content: 'Final result.' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('shows reasoning summaries but never forwards raw reasoning text', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        summaryIndex: 0,
        delta: 'Safe summary',
      }),
    ).toEqual([{ type: 'thinking', delta: 'Safe summary' }]);
    expect(
      translator.translate('item/reasoning/textDelta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        contentIndex: 0,
        delta: 'raw reasoning',
      }),
    ).toEqual([]);
  });

  it('maps late tool completion into a complete tool pair', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [{ path: '/repo/a.ts', kind: 'update' }],
          status: 'failed',
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'file-1',
        name: 'FileChange',
        input: { changes: [{ path: '/repo/a.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        id: 'file-1',
        output: JSON.stringify({
          status: 'failed',
          changes: [{ path: '/repo/a.ts', kind: 'update' }],
        }),
        isError: true,
      },
    ]);
    expect(translator.protocolDrift()).toMatchObject({ anomalies: 1 });
  });

  it('keeps retryable errors non-terminal and uses the final failed turn as authority', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('error', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        error: { message: 'retrying' },
        willRetry: true,
      }),
    ).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
    expect(
      translator.translate('turn/completed', {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          items: [],
          error: { message: 'model stopped' },
        },
      }),
    ).toEqual([
      { type: 'error', message: 'model stopped', terminationReason: 'failed' },
    ]);
    expect(translator.finish()).toEqual([]);
  });

  it('maps interruption and local stop to one terminal event', () => {
    const notified = new CodexAppServerEventTranslator();
    notified.setContext('thread-stop', 'turn-stop');
    expect(
      notified.translate('turn/completed', {
        threadId: 'thread-stop',
        turn: { id: 'turn-stop', status: 'interrupted', items: [] },
      }),
    ).toEqual([
      { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    ]);
    expect(notified.finish('interrupted')).toEqual([]);

    const local = new CodexAppServerEventTranslator();
    local.setContext('thread-stop', 'turn-stop');
    expect(local.finish('interrupted')).toEqual([
      { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    ]);
    expect(local.finish('interrupted')).toEqual([]);
  });

  it('ignores other turns and tracks additive protocol drift', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(
      translator.translate('item/agentMessage/delta', {
        threadId: 'thread-2',
        turnId: 'turn-2',
        itemId: 'msg',
        delta: 'wrong run',
      }),
    ).toEqual([]);
    expect(translator.translate('future/notification', { value: 1 })).toEqual([]);
    expect(translator.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 1 });
  });
});
