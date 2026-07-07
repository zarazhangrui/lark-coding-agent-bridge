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

  it('passes profile-scoped larkChannel env vars to the spawned process', async () => {
    let captured: Record<string, unknown> | undefined;
    const queryFn = ((params: { options?: Record<string, unknown> }) => {
      captured = params.options;
      return fakeQuery([{ type: 'result', subtype: 'success', session_id: 'sess-1' }])(params);
    }) as never;

    const adapter = new ClaudeSdkAdapter({
      larkChannel: {
        profile: 'proj',
        rootDir: '/root/dir',
        larkCliConfigDir: '/cfg/dir',
        larkCliSourceConfigFile: '/cfg/source.json',
      },
      queryFn,
    });
    const run = adapter.run({ runId: 'r1', prompt: 'hello', cwd: '/w' });
    await collect(run.events);

    const env = captured?.env as NodeJS.ProcessEnv | undefined;
    expect(env).toBeDefined();
    // Derived by buildLarkChannelEnv (src/agent/lark-channel-env.ts):
    // - LARK_CHANNEL_PROFILE <- context.profile
    // - LARK_CHANNEL_HOME <- context.rootDir
    // - LARK_CHANNEL_CONFIG <- context.larkCliSourceConfigFile (takes priority over rootDir-derived default)
    // - LARKSUITE_CLI_CONFIG_DIR <- context.larkCliConfigDir
    expect(env?.LARK_CHANNEL_PROFILE).toBe('proj');
    expect(env?.LARK_CHANNEL_HOME).toBe('/root/dir');
    expect(env?.LARK_CHANNEL_CONFIG).toBe('/cfg/source.json');
    expect(env?.LARKSUITE_CLI_CONFIG_DIR).toBe('/cfg/dir');
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

  it('surfaces an error AgentEvent when the query stream throws mid-stream', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: (() => {
        const iterable = (async function* () {
          yield {
            type: 'assistant',
            session_id: 's',
            message: { content: [{ type: 'text', text: 'hi' }] },
          };
          throw new Error('boom');
        })();
        return Object.assign(iterable, { interrupt: async () => {} });
      }) as never,
    });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w' });
    const events = await collect(run.events);
    // Not aborted, so the catch (err) branch in run() sets terminationReason: 'failed'.
    expect(events[events.length - 1]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
});

describe('ClaudeSdkAdapter interactive approval', () => {
  // fake query that drives canUseTool from options, then finishes.
  function approvalQuery() {
    return ((params: { options?: Record<string, unknown> }) => {
      const canUseTool = params.options?.canUseTool as
        | ((n: string, i: unknown, o: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>)
        | undefined;
      const iterable = (async function* () {
        const controller = params.options?.abortController as AbortController;
        const decision = await canUseTool!('Bash', { command: 'rm -rf x' }, {
          signal: controller.signal,
          toolUseID: 'tu-1',
        });
        yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: JSON.stringify(decision) }] } };
        yield { type: 'result', subtype: 'success', session_id: 's' };
      })();
      return Object.assign(iterable, { interrupt: async () => {} });
    }) as never;
  }

  it('emits permission_request and honors an allow response', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery(), approvalEnabled: true });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: 'permission_request', id: 'tu-1', toolName: 'Bash' });
    run.respondPermission!('tu-1', 'allow');
    const second = await it.next();
    expect(second.value).toMatchObject({ type: 'text' });
    expect((second.value as { delta: string }).delta).toContain('"behavior":"allow"');
  });

  it('auto-denies a parked permission when the run is stopped', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery(), approvalEnabled: true });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    await it.next(); // permission_request
    await run.stop();
    const rest: string[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value.type);
    // The parked promise resolved to deny (not hung); stream terminates.
    expect(rest.some((t) => t === 'text' || t === 'error' || t === 'done')).toBe(true);
  });

  it('force-denies a NEW canUseTool call made after the run is already aborted, without parking it', async () => {
    // Fake query that: 1) parks a first permission (tu-1), 2) waits for that
    // promise to settle (via stop()'s abort), then 3) issues a SECOND
    // canUseTool call (tu-2) for a different tool -- this happens AFTER
    // controller.signal.aborted is already true, reproducing the finding.
    let secondCallPromise:
      | Promise<{ behavior: 'allow' | 'deny'; message?: string }>
      | undefined;

    const adapter = new ClaudeSdkAdapter({
      // Deliberately large so a pass proves the abort-check resolved it,
      // not the timeout.
      permissionTimeoutMs: 5 * 60 * 1000,
      approvalEnabled: true,
      queryFn: ((params: { options?: Record<string, unknown> }) => {
        const canUseTool = params.options?.canUseTool as
          | ((n: string, i: unknown, o: { signal: AbortSignal; toolUseID: string }) => Promise<{
              behavior: 'allow' | 'deny';
              message?: string;
            }>)
          | undefined;
        const controller = params.options?.abortController as AbortController;
        const iterable = (async function* () {
          const firstPromise = canUseTool!('Bash', { command: 'echo one' }, {
            signal: controller.signal,
            toolUseID: 'tu-1',
          });
          yield {
            type: 'assistant',
            session_id: 's',
            message: { content: [{ type: 'text', text: 'first-parked' }] },
          };
          await firstPromise; // resolved by stop()'s abort listener (existing behavior)
          // At this point controller.signal.aborted is true. A brand-new
          // permission prompt arrives for a different tool.
          secondCallPromise = canUseTool!('Bash', { command: 'echo two' }, {
            signal: controller.signal,
            toolUseID: 'tu-2',
          });
          const secondDecision = await secondCallPromise;
          yield {
            type: 'assistant',
            session_id: 's',
            message: { content: [{ type: 'text', text: JSON.stringify(secondDecision) }] },
          };
          yield { type: 'result', subtype: 'success', session_id: 's' };
        })();
        return Object.assign(iterable, { interrupt: async () => {} });
      }) as never,
    });

    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: 'permission_request', id: 'tu-1' });

    await run.stop();

    expect(secondCallPromise).toBeDefined();
    // Race against a short real-timer window: if the fix is missing, the
    // second permission is parked behind a dead abort listener and only the
    // 5-minute timeout would resolve it, so this race loses deterministically
    // and quickly instead of hanging for the real test suite duration.
    const race = await Promise.race([
      secondCallPromise!.then((value) => ({ kind: 'resolved' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 200)),
    ]);
    expect(race).toEqual({ kind: 'resolved', value: { behavior: 'deny', message: 'run stopped' } });
  });

  it('denies prompted tools immediately when approvalEnabled is not set (no permission_request, no park)', async () => {
    // Fake query that: 1) checks an auto-allow tool still allows, then
    // 2) calls canUseTool for a prompted tool (Bash) and captures the
    // resolution promptly -- this must resolve to deny WITHOUT emitting a
    // permission_request and without waiting on the (huge) permission timer.
    let readDecision: unknown;
    let bashDecision: unknown;
    const adapter = new ClaudeSdkAdapter({
      // Deliberately large: if the fix regresses to parking, this test
      // would hang for the suite duration instead of just failing fast.
      permissionTimeoutMs: 5 * 60 * 1000,
      queryFn: ((params: { options?: Record<string, unknown> }) => {
        const canUseTool = params.options?.canUseTool as
          | ((n: string, i: unknown, o: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>)
          | undefined;
        const controller = params.options?.abortController as AbortController;
        const iterable = (async function* () {
          readDecision = await canUseTool!('Read', { file_path: '/w/a.txt' }, {
            signal: controller.signal,
            toolUseID: 'tu-read',
          });
          bashDecision = await canUseTool!('Bash', { command: 'echo hi' }, {
            signal: controller.signal,
            toolUseID: 'tu-bash',
          });
          yield { type: 'result', subtype: 'success', session_id: 's' };
        })();
        return Object.assign(iterable, { interrupt: async () => {} });
      }) as never,
    });

    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const events = await collect(run.events);

    expect(readDecision).toEqual({ behavior: 'allow' });
    expect(bashDecision).toEqual({ behavior: 'deny', message: 'interactive approval not available' });
    expect(events.some((e) => e.type === 'permission_request')).toBe(false);
  });
});
