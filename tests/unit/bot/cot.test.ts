import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  CotRequestError,
  cotBriefToolTitle,
  finalAnswerOnlyState,
} from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';
import { log } from '../../../src/core/logger.js';

const SERIALIZATION_SECRET = 'do-not-log-serialization-secret';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('COT event mapping', () => {
  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('preserves Unicode text and reasoning deltas without lossy pre-splitting', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: '00000000-0000-0000-0000-000000000000',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();
    const reasoning = '推理🙂"\\\n'.repeat(60);
    const text = '过程🙂"\\\n'.repeat(60);

    await consumeCotEvents(iterate([
      { type: 'thinking', delta: reasoning },
      { type: 'text', delta: text },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(client.updates).toHaveLength(1);
    expectJoinedDelta(client.events, 'REASONING_MESSAGE_CONTENT', reasoning);
    expectJoinedDelta(client.events, 'TEXT_MESSAGE_CONTENT', text);
    expectContentLifecycle(client.events, 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END');
    expectContentLifecycle(client.events, 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END');
  });

  it('keeps the existing per-delta text cap without splitting an emoji surrogate pair', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-unicode-cap',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: `${'a'.repeat(1199)}🙂tail` },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expectJoinedDelta(
      client.events,
      'TEXT_MESSAGE_CONTENT',
      `${'a'.repeat(1199)}...`,
    );
  });

  it('preserves the serialized value of detailed tool arguments', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-tool-args',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();
    const input = { command: 'echo', payload: '参数🙂"\\\n'.repeat(80) };

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-long', name: 'command_execution', input },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expectJoinedDelta(client.events, 'TOOL_CALL_ARGS', JSON.stringify(input));
    expectContentLifecycle(client.events, 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END');
  });

  it('caps oversized detailed tool arguments at the shared text limit', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-tool-args-cap');
    await publisher.start();
    const input = { file_path: '/tmp/big.txt', content: '写🙂'.repeat(2000) };

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-huge', name: 'Write', input },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    const args = client.events.filter((event) => event.event_type === 'TOOL_CALL_ARGS');
    expect(args.length).toBeGreaterThan(0);
    const joined = args
      .map((event) => (JSON.parse(event.content) as { delta: string }).delta)
      .join('');
    // truncateCot cuts at 1200 UTF-16 code units plus the ellipsis marker.
    expect(joined.length).toBeLessThanOrEqual(1203);
    expect(joined.endsWith('...')).toBe(true);
    expect(joined.startsWith(JSON.stringify(input).slice(0, 100))).toBe(true);
    expect(publisher.disabled).toBe(false);
    expect(client.completed).toEqual(['done']);
  });

  it('does not merge deltas that have already been sent in separate updates', async () => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-consecutive-updates',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();
    await vi.advanceTimersByTimeAsync(600);
    const first = '第一批🙂"\\\n'.repeat(50);
    const second = '第二批🙂"\\\n'.repeat(50);

    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId: 'text-consecutive',
      delta: first,
    });
    await vi.advanceTimersByTimeAsync(600);
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId: 'text-consecutive',
      delta: second,
    });
    await vi.advanceTimersByTimeAsync(600);

    const contentUpdates = client.updates.filter((events) =>
      events.some((event) => event.event_type === 'TEXT_MESSAGE_CONTENT'));
    expect(contentUpdates).toHaveLength(2);
    expectJoinedDelta(contentUpdates[0] ?? [], 'TEXT_MESSAGE_CONTENT', first);
    expectJoinedDelta(contentUpdates[1] ?? [], 'TEXT_MESSAGE_CONTENT', second);
  });

  it('coalesces many adjacent text deltas for the same message before sending', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-coalesce');
    await publisher.start();
    const deltas = Array.from({ length: 100 }, (_, index) => `片段${index}🙂|`);

    for (const delta of deltas) {
      publisher.enqueueDelta({
        eventType: 'TEXT_MESSAGE_CONTENT',
        messageId: 'text-coalesce',
        delta,
      });
    }
    await publisher.finish('done');

    const contents = client.events.filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT');
    // 100 tiny deltas must coalesce into a handful of fixed-size events, not
    // one wire event per agent delta (the pre-fix failure mode).
    expect(contents.length).toBeLessThan(10);
    expectJoinedDelta(contents, 'TEXT_MESSAGE_CONTENT', deltas.join(''));
    expect(client.completed).toEqual(['done']);
  });

  it('safely truncates an oversized input preview instead of degrading on RUN_STARTED', async () => {
    const client = new FakeCotClient();
    const inputPreview = hostileAtomicText(2000);
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-long-input-preview',
      scope: 'oc_chat',
      inputPreview,
    });

    await publisher.start();
    await publisher.finish('done');

    const started = client.events.find((event) => event.event_type === 'RUN_STARTED');
    expect(started).toBeDefined();
    expect([...started!.content].length).toBeLessThanOrEqual(4096);
    const query = (JSON.parse(started!.content) as { input: { query: string } }).input.query;
    expect(query.length).toBeGreaterThan(0);
    expect(query.length).toBeLessThan(inputPreview.length);
    expectHostileTextPreserved(query);
    for (const events of client.updates) {
      expect(cotUpdateBodyBytes(events)).toBeLessThanOrEqual(32 * 1024);
    }
    expect(publisher.disabled).toBe(false);
    expect(client.completed).toEqual(['done']);
  });

  it('safely truncates an oversized RUN_ERROR message and still completes the COT', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-long-error');
    await publisher.start();
    const message = hostileAtomicText(2000);

    await consumeCotEvents(iterate([
      { type: 'error', message, terminationReason: 'failed' },
    ]), publisher, { detail: 'brief' });

    const runError = client.events.find((event) => event.event_type === 'RUN_ERROR');
    expect(runError).toBeDefined();
    expect([...runError!.content].length).toBeLessThanOrEqual(4096);
    const sentMessage = (JSON.parse(runError!.content) as { message: string }).message;
    expect(sentMessage.length).toBeGreaterThan(0);
    expect(sentMessage.length).toBeLessThan(message.length);
    expectHostileTextPreserved(sentMessage);
    for (const events of client.updates) {
      expect(cotUpdateBodyBytes(events)).toBeLessThanOrEqual(32 * 1024);
    }
    expect(publisher.disabled).toBe(false);
    expect(client.completed).toEqual(['error']);
  });

  it('safely truncates a detailed tool result with worst-case JSON escaping', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-hostile-tool-result');
    await publisher.start();
    const output = hostileAtomicText(2000);

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-hostile', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-hostile', output, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(result).toBeDefined();
    expect([...result!.content].length).toBeLessThanOrEqual(4096);
    const sentOutput = (JSON.parse(result!.content) as { content: string }).content;
    expect(sentOutput.length).toBeGreaterThan(0);
    expect(sentOutput.length).toBeLessThan(output.length);
    expectHostileTextPreserved(sentOutput);
    for (const events of client.updates) {
      expect(cotUpdateBodyBytes(events)).toBeLessThanOrEqual(32 * 1024);
    }
    expect(publisher.disabled).toBe(false);
    expect(client.completed).toEqual(['done']);
  });

  it('splits updates by the event-count budget while preserving exact order', async () => {
    const client = new FakeCotClient();
    client.onUpdate = async () => {
      await Promise.resolve();
    };
    const publisher = createPublisher(client, 'run-event-budget');
    await publisher.start();

    for (let sequence = 1; sequence <= 75; sequence++) {
      publisher.enqueue('COUNT_TEST', { sequence });
    }
    await publisher.finish('done');

    expect(client.updates.length).toBeGreaterThan(1);
    // Protocol boundary: the probe-measured server limit is 50 events per
    // PUT (51 is rejected), independent of the client's internal batch size.
    for (const events of client.updates) expect(events.length).toBeLessThanOrEqual(50);
    expect(client.maxConcurrentUpdates).toBe(1);
    expect(eventSequences(client.events, 'COUNT_TEST')).toEqual(
      Array.from({ length: 75 }, (_, index) => index + 1),
    );
    expect(client.events.slice(0, 2).map((event) => event.event_type)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
    ]);
    expect(client.completed).toEqual(['done']);
  });

  it('splits updates by body size inside the measured-safe byte boundary', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-body-budget');
    await publisher.start();
    const payload = 'x'.repeat(3900);

    for (let sequence = 1; sequence <= 12; sequence++) {
      publisher.enqueue('BODY_TEST', { sequence, payload });
    }
    await publisher.finish('done');

    // Fourteen events (including start()) stay far below the 50-event server
    // limit but total ~48 KiB, so more than one PUT demonstrates the byte
    // packing kept every request inside the probe-measured 32 KiB pass zone.
    expect(client.events).toHaveLength(14);
    expect(client.updates.length).toBeGreaterThan(1);
    for (const events of client.updates) {
      expect(cotUpdateBodyBytes(events)).toBeLessThanOrEqual(32 * 1024);
    }
    expect(eventSequences(client.events, 'BODY_TEST')).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(client.completed).toEqual(['done']);
  });

  it('splits one oversized delta into multiple events within the measured content limit', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-single-delta-content-limit');
    await publisher.start();
    const messageId = 'text-single-large-content';
    // Each backslash escapes to two characters inside the event content, so
    // 3000 backslashes need ~6000 content chars — more than the measured
    // 4096-char single-event limit — and must land in multiple events.
    const expected = '\\'.repeat(3000);
    publisher.enqueue('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: expected,
    });
    publisher.enqueue('TEXT_MESSAGE_END', { messageId });

    await publisher.finish('done');

    const appliedContent = client.events.filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT');
    expect(appliedContent.length).toBeGreaterThan(1);
    expectJoinedDelta(appliedContent, 'TEXT_MESSAGE_CONTENT', expected);
    for (const event of client.events) {
      expect([...event.content].length).toBeLessThanOrEqual(4096);
    }
    expectContentLifecycle(
      client.events,
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    );
    expect(client.completed).toEqual(['done']);
  });

  it('degrades on the first rejected update without retrying or splitting', async () => {
    const client = new FakeCotClient();
    client.onUpdate = async () => {
      throw fieldValidationError();
    };
    const publisher = createPublisher(client, 'run-update-rejected');
    await publisher.start();
    publisher.enqueue('REJECTED_TEST', { sequence: 1 });
    publisher.enqueue('MUST_NOT_SKIP_AHEAD', { sequence: 2 });

    await publisher.finish('done');

    // The budgets sit well below the probe-measured server limits, so a
    // deterministic rejection is never retried or bisected: one attempt,
    // then degradation without completing the bubble.
    expect(client.updateCalls).toHaveLength(1);
    expect(client.updateCalls[0]?.map((event) => event.event_type)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'REJECTED_TEST',
      'MUST_NOT_SKIP_AHEAD',
    ]);
    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toContain('99992402');
    expect(client.events).toEqual([]);
    expect(client.completed).toEqual([]);
  });

  it('waits for the current update to drain before completing', async () => {
    const gate = deferred<void>();
    const client = new FakeCotClient();
    client.onUpdate = async () => gate.promise;
    const publisher = createPublisher(client, 'run-finish-drain');
    await publisher.start();
    publisher.enqueue('DRAIN_TEST', { sequence: 1 });
    let finished = false;

    const finishing = publisher.finish('done').then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(client.updateCalls).toHaveLength(1);
    expect(finished).toBe(false);
    expect(client.completed).toEqual([]);

    gate.resolve();
    await finishing;

    expect(finished).toBe(true);
    expect(client.events.map((event) => event.event_type)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'DRAIN_TEST',
    ]);
    expect(client.completed).toEqual(['done']);
  });

  it('completes only once when finish is called concurrently or repeatedly', async () => {
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-idempotent-finish');
    await publisher.start();
    publisher.enqueue('FINISH_ONCE_TEST', { sequence: 1 });

    await Promise.all([
      publisher.finish('done'),
      publisher.finish('error'),
    ]);
    await publisher.finish('error');

    expect(eventSequences(client.events, 'FINISH_ONCE_TEST')).toEqual([1]);
    expect(client.completed).toEqual(['done']);
  });

  it('snapshots an in-flight delta and drains a later adjacent delta before completing', async () => {
    vi.useFakeTimers();
    const firstUpdate = deferred<void>();
    const client = new FakeCotClient();
    client.onUpdate = async (_events, callIndex) => {
      if (callIndex === 0) await firstUpdate.promise;
    };
    const publisher = createPublisher(client, 'run-enqueue-during-flush');
    await publisher.start();
    const messageId = 'text-during-flush';
    const first = '首批🙂';
    const second = '次批\\\n';
    const afterFinish = '不应发送';
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: first,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(client.updateCalls).toHaveLength(1);
    expectJoinedDelta(client.updateCalls[0] ?? [], 'TEXT_MESSAGE_CONTENT', first);
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: second,
    });
    const finishing = publisher.finish('done');
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: afterFinish,
    });

    firstUpdate.resolve();
    await finishing;

    expect(client.updateCalls.length).toBeGreaterThanOrEqual(2);
    expectJoinedDelta(client.events, 'TEXT_MESSAGE_CONTENT', first + second);
    const appliedDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => (JSON.parse(event.content) as { delta: string }).delta);
    expect(appliedDeltas).toEqual([first, second]);
    expect(client.events.slice(0, 2).map((event) => event.event_type)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
    ]);
    expect(client.completed).toEqual(['done']);
  });

  it('starts a fresh throttle window for a delta queued during an in-flight update', async () => {
    vi.useFakeTimers();
    const firstUpdate = deferred<void>();
    const client = new FakeCotClient();
    client.onUpdate = async (_events, callIndex) => {
      if (callIndex === 0) await firstUpdate.promise;
    };
    const publisher = createPublisher(client, 'run-throttle-after-flush');
    await publisher.start();
    const messageId = 'text-throttle-after-flush';
    const first = '第一个窗口';
    const second = '第二个窗口';
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: first,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(client.updateCalls).toHaveLength(1);
    publisher.enqueueDelta({
      eventType: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: second,
    });

    firstUpdate.resolve();
    await vi.advanceTimersByTimeAsync(599);
    expect(client.updateCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.updateCalls).toHaveLength(2);
    expectJoinedDelta(client.updateCalls[0] ?? [], 'TEXT_MESSAGE_CONTENT', first);
    expectJoinedDelta(client.updateCalls[1] ?? [], 'TEXT_MESSAGE_CONTENT', second);
    expectJoinedDelta(client.events, 'TEXT_MESSAGE_CONTENT', first + second);
    expect(client.completed).toEqual([]);
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.updateCalls).toHaveLength(1);
    expect(client.completed).toEqual([]);
  });

  it.each([
    { name: 'circular value', makeContent: circularCotContent },
    { name: 'BigInt value', makeContent: bigintCotContent },
    { name: 'throwing toJSON', makeContent: throwingToJsonCotContent },
  ])('safely degrades when enqueue receives $name', async ({ makeContent }) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new FakeCotClient();
    const publisher = createPublisher(client, 'run-unserializable-content');
    await publisher.start();
    const safeReason = 'COT UNSERIALIZABLE_TEST content 序列化失败';

    expect(() => {
      publisher.enqueue('UNSERIALIZABLE_TEST', makeContent());
    }).not.toThrow();

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe(safeReason);
    expect(publisher.degradedReason).not.toContain(SERIALIZATION_SECRET);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('cot', 'update-failed', { err: safeReason });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SERIALIZATION_SECRET);
    expect(client.updateCalls).toEqual([]);
    expect(client.completed).toEqual([]);
  });

  it('preserves Feishu validation details and logs only safe update diagnostics', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    (client as unknown as { tenantToken(): Promise<string> }).tenantToken = async () => 'token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 99992402, msg: 'field validation failed' }),
      {
        status: 400,
        headers: { 'x-tt-logid': 'tt-log-safe' },
      },
    )));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const event = {
      event_type: 'TEXT_MESSAGE_CONTENT',
      content: JSON.stringify({ messageId: 'message', delta: 'sensitive body' }),
      timestamp: 1,
    };

    await expect(client.update(
      { cotId: 'cot', messageId: 'message' },
      [event],
    )).rejects.toThrow(
      'COT HTTP 400 code=99992402 msg=field validation failed ttLogId=tt-log-safe',
    );

    expect(warn).toHaveBeenCalledWith('cot', 'update-request-failed', expect.objectContaining({
      httpStatus: 400,
      apiCode: 99992402,
      apiMessage: 'field validation failed',
      ttLogId: 'tt-log-safe',
      eventStats: [{
        eventType: 'TEXT_MESSAGE_CONTENT',
        contentBytes: Buffer.byteLength(event.content, 'utf8'),
      }],
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive body');
  });
});

class FakeCotClient {
  events: CotTestEvent[] = [];
  updates: Array<readonly CotTestEvent[]> = [];
  updateCalls: Array<readonly CotTestEvent[]> = [];
  maxConcurrentUpdates = 0;
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  onUpdate: ((events: readonly CotTestEvent[], callIndex: number) => Promise<void>) | undefined;
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly CotTestEvent[]): Promise<void> {
    const callIndex = this.updateCalls.length;
    // Capture the wire-level snapshot before awaiting. A shallow copy would
    // let an incorrect in-place CoT merge rewrite the recorded first PUT and
    // hide the same race that real JSON serialization prevents.
    const snapshot = events.map((event) => ({ ...event }));
    this.updateCalls.push(snapshot);
    this.activeUpdates++;
    this.maxConcurrentUpdates = Math.max(this.maxConcurrentUpdates, this.activeUpdates);
    try {
      if (this.failUpdate) throw this.failUpdate;
      if (this.onUpdate) await this.onUpdate(snapshot, callIndex);
      this.updates.push(snapshot);
      this.events.push(...snapshot);
    } finally {
      this.activeUpdates--;
    }
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }

  private activeUpdates = 0;
}

interface CotTestEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

function createPublisher(client: FakeCotClient, runId: string): CotPublisher {
  return new CotPublisher({
    client,
    chatId: 'oc_chat',
    originMessageId: 'om_origin',
    runId,
    scope: 'oc_chat',
    inputPreview: 'run',
  });
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

function expectJoinedDelta(
  events: readonly { event_type: string; content: string }[],
  eventType: string,
  expected: string,
): void {
  const chunks = events
    .filter((event) => event.event_type === eventType)
    .map((event) => {
      const delta = (JSON.parse(event.content) as { delta?: unknown }).delta;
      expect(typeof delta).toBe('string');
      const text = delta as string;
      expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
      return text;
    });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.join('')).toBe(expected);
}

function expectContentLifecycle(
  events: readonly { event_type: string }[],
  startType: string,
  contentType: string,
  endType: string,
): void {
  const types = events.map((event) => event.event_type);
  const start = types.indexOf(startType);
  const end = types.indexOf(endType);
  const contentIndexes = types
    .map((type, index) => type === contentType ? index : undefined)
    .filter((index): index is number => index !== undefined);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(contentIndexes.length).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(contentIndexes.at(-1)!);
  expect(contentIndexes[0]).toBeGreaterThan(start);
  expect(contentIndexes).toEqual(
    Array.from({ length: contentIndexes.length }, (_, index) => contentIndexes[0]! + index),
  );
}

function eventSequences(events: readonly CotTestEvent[], eventType: string): number[] {
  return events
    .filter((event) => event.event_type === eventType)
    .map((event) => (JSON.parse(event.content) as { sequence: number }).sequence);
}

function cotUpdateBodyBytes(events: readonly CotTestEvent[]): number {
  return Buffer.byteLength(JSON.stringify({
    cot_id: 'cot_fake',
    message_id: 'om_cot_fake',
    events,
  }), 'utf8');
}

function hostileAtomicText(repeats: number): string {
  // The high and low surrogates are deliberately separated so each remains
  // unpaired. Together with NUL, quotes and backslashes this exercises the
  // largest JSON escape expansions without inserting invalid source bytes.
  return '\0\uD800x\uDC00y\\"'.repeat(repeats);
}

function expectHostileTextPreserved(value: string): void {
  expect(value).toContain('\0');
  expect(value).toContain('\uD800');
  expect(value).toContain('\uDC00');
}

function circularCotContent(): unknown {
  const content: Record<string, unknown> = { marker: SERIALIZATION_SECRET };
  content.self = content;
  return content;
}

function bigintCotContent(): unknown {
  return { marker: SERIALIZATION_SECRET, value: BigInt(1) };
}

function throwingToJsonCotContent(): unknown {
  return {
    toJSON(): never {
      throw new Error(SERIALIZATION_SECRET);
    },
  };
}

function fieldValidationError(): CotRequestError {
  return new CotRequestError({
    httpStatus: 400,
    apiCode: 99992402,
    apiMessage: 'field validation failed',
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}
