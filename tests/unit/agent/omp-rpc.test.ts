import { describe, expect, it } from 'vitest';
import { OmpRpcFrameDecoder, OmpRpcTranslator } from '../../../src/agent/omp/rpc';

describe('OMP RPC frame decoder', () => {
  it('passes protocol-v1 frames through unchanged', () => {
    const decoder = new OmpRpcFrameDecoder();
    expect(decoder.decode('{"type":"ready","protocolVersion":1}')).toEqual({
      type: 'ready',
      protocolVersion: 1,
    });
  });

  it('reassembles protocol-v2 chunks in order', () => {
    const logical = { type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } };
    const bytes = Buffer.from(JSON.stringify(logical), 'utf8');
    const half = Math.ceil(bytes.length / 2);
    const parts = [bytes.subarray(0, half), bytes.subarray(half)];
    const frames = parts.map((part, index) =>
      JSON.stringify({
        type: 'rpc_chunk',
        chunkId: 'rpc-1',
        index,
        count: parts.length,
        byteLength: bytes.length,
        data: part.toString('base64'),
      }),
    );

    const decoder = new OmpRpcFrameDecoder();
    expect(decoder.decode(frames[0]!)).toBeUndefined();
    expect(decoder.decode(frames[1]!)).toEqual(logical);
  });

  it('rejects a sequence that does not start at index 0', () => {
    const decoder = new OmpRpcFrameDecoder();
    expect(() =>
      decoder.decode(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'rpc-1',
          index: 1,
          count: 2,
          byteLength: 10,
          data: Buffer.from('xy').toString('base64'),
        }),
      ),
    ).toThrow(/did not start at index 0/);
  });

  it('rejects an interleaved frame while a chunk sequence is pending', () => {
    const decoder = new OmpRpcFrameDecoder();
    decoder.decode(
      JSON.stringify({
        type: 'rpc_chunk',
        chunkId: 'rpc-1',
        index: 0,
        count: 2,
        byteLength: 10,
        data: Buffer.from('xy').toString('base64'),
      }),
    );
    expect(() => decoder.decode('{"type":"ready"}')).toThrow(/interrupted/);
  });
});

describe('OMP RPC translator', () => {
  it('emits the session id and model from get_state', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translator.translate({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'sess-1', model: { id: 'test/model' } },
      }),
    ).toEqual([{ type: 'system', sessionId: 'sess-1', model: 'test/model' }]);
  });

  it('streams text, closes with final_text, and forwards usage', () => {
    const translator = new OmpRpcTranslator();
    translator.translate({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(
      translator.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      }),
    ).toEqual([{ type: 'text', delta: 'Hello ' }]);
    expect(
      translator.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      }),
    ).toEqual([{ type: 'text', delta: 'world' }]);
    expect(
      translator.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
          usage: { input: 10, output: 2, cacheRead: 3 },
        },
      }),
    ).toEqual([
      { type: 'final_text', content: 'Hello world' },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 3,
      },
    ]);
  });

  it('falls back to the completed assistant message when no deltas arrive', () => {
    const translator = new OmpRpcTranslator();
    translator.translate({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(
      translator.translate({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'whole' }] },
      }),
    ).toEqual([
      { type: 'text', delta: 'whole' },
      { type: 'final_text', content: 'whole' },
    ]);
  });

  it('maps tool execution frames and ignores the duplicate toolResult message', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'echo hi' },
      }),
    ).toEqual([
      { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo hi' } },
    ]);
    expect(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'hi\n' }] },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'hi\n', isError: false }]);
    expect(
      translator.translate({
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'hi\n' }],
        },
      }),
    ).toEqual([]);
  });

  it('completes on prompt_result, not on agent_end', () => {
    const translator = new OmpRpcTranslator();
    translator.translate({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'sess-2' },
    });
    expect(translator.translate({ type: 'agent_end', yielded: true })).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
    expect(
      translator.translate({
        type: 'prompt_result',
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      }),
    ).toEqual([{ type: 'done', sessionId: 'sess-2', terminationReason: 'normal' }]);
  });

  it('surfaces prompt_result errors', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translator.translate({
        type: 'prompt_result',
        agentInvoked: true,
        status: 'error',
        error: { message: 'provider unavailable' },
      }),
    ).toEqual([
      { type: 'error', message: 'provider unavailable', terminationReason: 'failed' },
    ]);
  });

  it('treats an aborted prompt as an interrupted run', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translator.translate({ type: 'prompt_result', agentInvoked: true, status: 'aborted' }),
    ).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
  });

  it('falls back to a normal finish after an agent yield when prompt_result is missing', () => {
    const translator = new OmpRpcTranslator();
    translator.translate({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'sess-3' },
    });
    translator.translate({ type: 'agent_end', yielded: true });
    expect(translator.endedAfterAgentYield()).toBe(true);
    expect(translator.finish('normal')).toEqual([
      { type: 'done', sessionId: 'sess-3', terminationReason: 'normal' },
    ]);
  });

  it('reports a failed finish when the stream ends with no terminal frame', () => {
    const translator = new OmpRpcTranslator();
    expect(translator.finish('failed')).toEqual([
      expect.objectContaining({
        type: 'error',
        terminationReason: 'failed',
        message: expect.stringContaining('stream ended before a terminal event'),
      }),
    ]);
  });
});
