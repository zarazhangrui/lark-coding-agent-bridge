import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from '../../src/agent/claude/sdk-adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// A fake query() returning a fixed SDKMessage sequence.
function fakeQuery(messages: unknown[]) {
  return (params: { options?: Record<string, unknown> }) => {
    const iterable = (async function* () {
      for (const m of messages) yield m;
    })();
    return Object.assign(iterable, {
      _params: params,
      interrupt: async () => {},
    });
  };
}

describe('ClaudeSdkAdapter driver parity', () => {
  afterEach(() => {
    delete process.env.__SDK_ENV_PROBE__;
  });

  it('merges ambient process.env into options.env instead of replacing it', async () => {
    process.env.__SDK_ENV_PROBE__ = 'present';
    let captured: Record<string, unknown> | undefined;
    const queryFn = ((params: { options?: Record<string, unknown> }) => {
      captured = params.options;
      return fakeQuery([{ type: 'result', subtype: 'success', session_id: 'sess-1' }])(params);
    }) as never;

    const adapter = new ClaudeSdkAdapter({ binary: '/usr/bin/claude', queryFn });
    const run = adapter.run({ runId: 'r1', prompt: 'hello', cwd: '/work' });
    await collect(run.events);

    const env = captured?.env as NodeJS.ProcessEnv | undefined;
    expect(env).toBeDefined();
    expect(env?.__SDK_ENV_PROBE__).toBe('present');
    expect(env?.LARK_CHANNEL).toBe('1');
  });

  it('passes cwd, resume, model, bypass mode, and preset system prompt to query', async () => {
    let captured: Record<string, unknown> | undefined;
    const queryFn = ((params: { options?: Record<string, unknown> }) => {
      captured = params.options;
      return fakeQuery([{ type: 'result', subtype: 'success', session_id: 'sess-1' }])(params);
    }) as never;

    const adapter = new ClaudeSdkAdapter({ binary: '/usr/bin/claude', queryFn });
    const run = adapter.run({
      runId: 'r1',
      prompt: 'hello',
      cwd: '/work',
      sessionId: 'prev',
      model: 'claude-opus-4-8',
    });

    const events = await collect(run.events);
    expect(events).toEqual([{ type: 'done', sessionId: 'sess-1', terminationReason: 'normal' }]);
    expect(captured).toMatchObject({
      cwd: '/work',
      resume: 'prev',
      model: 'claude-opus-4-8',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(captured?.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  });

  it('translates a full message sequence', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: fakeQuery([
        { type: 'system', subtype: 'init', session_id: 's', cwd: '/w', model: 'm' },
        { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 2 } },
      ]) as never,
    });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w' });
    const events = await collect(run.events);
    expect(events.map((e) => e.type)).toEqual(['system', 'text', 'usage', 'done']);
  });

  it('aborts on stop() and yields a terminal event when the stream ends early', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: ((params: { options?: { abortController?: AbortController } }) => {
        const iterable = (async function* () {
          // Never emits a result; ends only when aborted.
          await new Promise<void>((resolve) => {
            params.options?.abortController?.signal.addEventListener('abort', () => resolve());
          });
        })();
        return Object.assign(iterable, { interrupt: async () => {} });
      }) as never,
    });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w' });
    const iterator = run.events[Symbol.asyncIterator]();
    const firstPromise = iterator.next();
    await run.stop();
    const first = await firstPromise;
    expect(first.done ? undefined : first.value.type).toBe('error');
  });
});
