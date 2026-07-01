import { describe, expect, it } from 'vitest';
import { consumeCotEvents, CotPublisher, cotBriefToolTitle, finalAnswerOnlyState } from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';

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
    expect(client.completed).toEqual([]);
  });
});

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  completed: string[] = [];
  failUpdate: Error | undefined;

  async create(): Promise<Record<string, unknown>> {
    return { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
