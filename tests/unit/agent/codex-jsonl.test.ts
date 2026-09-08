import { describe, expect, it } from 'vitest';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl.js';

describe('Codex JSONL translator', () => {
  it('translates thread, text, command execution, usage, and completion events', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { type: 'system', threadId: 'thread-1' },
    ]);
    expect(t.translate({ type: 'turn.started' })).toEqual([]);
    expect(
      t.translate({
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'pwd',
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'cmd-1',
        name: 'command_execution',
        input: { command: 'pwd' },
      },
    ]);
    expect(
      t.translate({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          output: '/repo\n',
          exit_code: 0,
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'cmd-1',
        output: '/repo\n',
        isError: false,
      },
    ]);
    expect(t.translate({ type: 'agent_message', message: 'hello' })).toEqual([]);
    expect(
      t.translate({
        type: 'turn.completed',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cached_input_tokens: 5,
          reasoning_output_tokens: 7,
        },
      }),
    ).toEqual([
      { type: 'final_text', content: 'hello' },
      {
        // No context size for Codex: `turn.completed.usage` looks like a
        // per-turn total (summed over the turn's requests) and there is no
        // per-request breakdown to recover the last one from.
        contextTokens: undefined,
        type: 'usage',
        inputTokens: 12,
        outputTokens: 34,
        cachedInputTokens: 5,
        reasoningOutputTokens: 7,
      },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('does not add Claude session ids to Codex system or done events', () => {
    const t = new CodexJsonlTranslator();
    const system = t.translate({ type: 'thread.started', thread_id: 'thread-1' })[0];
    const done = t.translate({ type: 'turn.completed' }).at(-1);

    expect(system).not.toHaveProperty('sessionId');
    expect(done).not.toHaveProperty('sessionId');
  });

  it('translates current Codex agent messages emitted as completed items', () => {
    const t = new CodexJsonlTranslator();

    expect(
      t.translate({
        type: 'item.completed',
        item: {
          id: 'msg-1',
          type: 'agent_message',
          text: 'hello from item',
        },
      }),
    ).toEqual([]);
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'hello from item' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('treats a message announced twice as one message', () => {
    // Some builds emit the same text both as a raw event and as a completed
    // item. Without this, copy #1 streams as commentary and copy #2 comes back
    // as the final answer — the user reads the same reply twice.
    const t = new CodexJsonlTranslator();

    expect(
      t.translate({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'hello world' },
      }),
    ).toEqual([]);
    expect(t.translate({ type: 'agent_message', message: 'hello world' })).toEqual([]);
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'hello world' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('streams earlier agent messages but reserves the last one as the final answer', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'agent_message', message: 'progress one' })).toEqual([]);
    expect(t.translate({ type: 'agent_message', message: 'progress two' })).toEqual([
      { type: 'text', delta: 'progress one' },
    ]);
    expect(
      t.translate({
        type: 'item.started',
        item: { id: 'cmd-after-progress', type: 'command_execution', command: 'pwd' },
      }),
    ).toEqual([
      { type: 'text', delta: 'progress two' },
      {
        type: 'tool_use',
        id: 'cmd-after-progress',
        name: 'command_execution',
        input: { command: 'pwd' },
      },
    ]);
    expect(t.translate({ type: 'agent_message', message: 'final answer' })).toEqual([]);
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('treats missing command exit codes as successful command results', () => {
    const t = new CodexJsonlTranslator();

    expect(
      t.translate({
        type: 'item.completed',
        item: {
          id: 'cmd-no-code',
          type: 'command_execution',
          output: 'done',
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'cmd-no-code',
        output: 'done',
        isError: false,
      },
    ]);
  });

  it('translates failed turns to one terminal error', () => {
    const t = new CodexJsonlTranslator();

    expect(
      t.translate({
        type: 'turn.failed',
        error: { message: 'command denied' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'command denied',
        terminationReason: 'failed',
      },
    ]);
    expect(t.translate({ type: 'error', message: 'late raw error' })).toEqual([]);
    expect(t.finish()).toEqual([]);
  });

  it('keeps raw error events non-terminal so retrying runs can continue', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'thread.started', thread_id: 'thread-retry' })).toEqual([
      { type: 'system', threadId: 'thread-retry' },
    ]);
    expect(
      t.translate({
        type: 'error',
        error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
      }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.translate({ type: 'agent_message', message: 'after retry' })).toEqual([]);
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('still treats turn.failed as terminal after a raw error event', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'error', message: 'Reconnecting... 2/5' })).toEqual([]);
    expect(
      t.translate({
        type: 'turn.failed',
        error: { message: 'model stopped' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'model stopped',
        terminationReason: 'failed',
      },
    ]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'agent_message', message: 'too late' })).toEqual([]);
  });

  it('preserves the latest raw error detail when the stream ends without a terminal event', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'error', message: 'transport failed' })).toEqual([]);
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'codex stream ended before a terminal event: transport failed',
        terminationReason: 'failed',
      },
    ]);
  });

  it('tracks protocol drift while ignoring unknown and anomalous events', () => {
    const t = new CodexJsonlTranslator();

    expect(t.translate({ type: 'unknown.future', value: 1 })).toEqual([]);
    expect(
      t.translate({
        type: 'item.completed',
        item: {
          id: 'cmd-late',
          type: 'command_execution',
          output: 'late',
          exit_code: 1,
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'cmd-late',
        output: 'late',
        isError: true,
      },
    ]);
    expect(t.protocolDrift()).toEqual({
      unknownEvents: 1,
      anomalies: 1,
    });
  });

  it('emits a failed terminal event on EOF without a terminal event', () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: 'thread.started', thread_id: 'thread-1' });

    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'codex stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it('lets stop and timeout override EOF terminal reason', () => {
    const stopped = new CodexJsonlTranslator();
    stopped.translate({ type: 'thread.started', thread_id: 'thread-stop' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    ]);

    const timedOut = new CodexJsonlTranslator();
    timedOut.translate({ type: 'thread.started', thread_id: 'thread-timeout' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'done', threadId: 'thread-timeout', terminationReason: 'timeout' },
    ]);
  });
});
