import { describe, expect, it } from 'vitest';
import {
  CodexAppServerEventTranslator,
  CodexAppServerJsonRpc,
  CodexAppServerRpcError,
} from '../../../src/agent/codex/app-server-jsonrpc.js';

describe('CodexAppServerJsonRpc', () => {
  it('correlates concurrent responses and rejects pending calls on close', async () => {
    const writes: unknown[] = [];
    const rpc = new CodexAppServerJsonRpc(async (message) => { writes.push(message); });
    const initialize = rpc.request('initialize', { capabilities: null });
    const thread = rpc.request('thread/start', { cwd: '/repo' });

    expect(writes).toEqual([
      { method: 'initialize', id: 1, params: { capabilities: null } },
      { method: 'thread/start', id: 2, params: { cwd: '/repo' } },
    ]);
    rpc.receive({ id: 2, result: { thread: { id: 'thread-1' } } });
    rpc.receive({ id: 1, result: { userAgent: 'codex' } });
    await expect(initialize).resolves.toEqual({ userAgent: 'codex' });
    await expect(thread).resolves.toEqual({ thread: { id: 'thread-1' } });

    const rejected = rpc.request('turn/start', {});
    rpc.fail(new Error('connection lost'));
    await expect(rejected).rejects.toThrow('connection lost');
    await expect(rpc.request('thread/start', {})).rejects.toThrow('connection lost');
  });

  it('classifies notifications/server requests and preserves RPC error metadata', async () => {
    const rpc = new CodexAppServerJsonRpc(async () => undefined);
    expect(rpc.receive({ method: 'turn/started', params: { threadId: 't' } })).toEqual({
      kind: 'notification', method: 'turn/started', params: { threadId: 't' },
    });
    expect(rpc.receive({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} })).toEqual({
      kind: 'request', id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {},
    });

    const pending = rpc.request('thread/resume', { threadId: 'missing' });
    rpc.receive({ id: 1, error: { code: -32000, message: 'thread not found', data: { stale: true } } });
    await expect(pending).rejects.toMatchObject({
      name: 'CodexAppServerRpcError', method: 'thread/resume', code: -32000, data: { stale: true },
    } satisfies Partial<CodexAppServerRpcError>);
  });
});

describe('CodexAppServerEventTranslator', () => {
  it('keeps final text buffered while streaming commentary and maps terminal turn', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');

    expect(translator.translate('item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '' },
    })).toEqual([]);
    expect(translator.translate('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'commentary-1', delta: 'checking',
    })).toEqual([{ type: 'text', delta: 'checking' }]);
    expect(translator.translate('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'checking now' },
    })).toEqual([{ type: 'text', delta: ' now' }]);

    translator.translate('item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '' },
    });
    translator.translate('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', delta: 'answer',
    });
    expect(translator.translate('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    })).toEqual([
      { type: 'final_text', content: 'answer' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('filters notifications belonging to another topic and safely closes interrupted turns', () => {
    const translator = new CodexAppServerEventTranslator();
    translator.setContext('thread-1', 'turn-1');
    expect(translator.translate('item/agentMessage/delta', {
      threadId: 'thread-2', turnId: 'turn-2', itemId: 'wrong', delta: 'wrong topic',
    })).toEqual([]);
    expect(translator.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 1 });
    expect(translator.finish('interrupted')).toEqual([
      { type: 'done', threadId: 'thread-1', terminationReason: 'interrupted' },
    ]);
    expect(translator.finish('interrupted')).toEqual([]);
  });
});

