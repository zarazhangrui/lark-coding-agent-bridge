import { describe, expect, it } from 'vitest';
import {
  getCardPayloadViolation,
  renderCard,
} from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderBoundedText, renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });

  it('truncates oversized card and markdown text payloads', () => {
    const state = stateFrom([
      { type: 'text', delta: `start ${'x'.repeat(20_000)} end-marker` },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    const boundedText = renderBoundedText(state);

    expect(card).toContain('回复过长');
    expect(card).toContain('end-marker');
    expect(text).not.toContain('回复过长');
    expect(text).toContain('end-marker');
    expect(text.length).toBeGreaterThan(12_000);
    expect(boundedText).toContain('回复过长');
    expect(boundedText).toContain('start ');
    expect(boundedText).toContain('end-marker');
    expect(boundedText.length).toBeLessThanOrEqual(12_000);
  });

  it('preserves the final answer when bounding long tool history', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      events.push({
        type: 'tool_use',
        id: `tool-${i}`,
        name: 'Bash',
        input: { command: `echo ${i} ${'x'.repeat(80)}` },
      });
      events.push({ type: 'tool_result', id: `tool-${i}`, output: 'ok', isError: false });
    }
    events.push({ type: 'text', delta: 'the actual final answer' });
    events.push({ type: 'done', terminationReason: 'normal' });

    const bounded = renderBoundedText(stateFrom(events));

    expect(bounded).toContain('回复过长');
    expect(bounded).toContain('the actual final answer');
    expect(bounded.length).toBeLessThanOrEqual(12_000);
  });

  it('does not split surrogate pairs at truncation boundaries', () => {
    const state = stateFrom([
      { type: 'text', delta: `${'a'.repeat(3991)}😀${'b'.repeat(20_000)}😀tail` },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const bounded = renderBoundedText(state);
    const card = renderCard(state) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const cardContent = card.body?.elements?.map((element) => element.content ?? '').join('') ?? '';

    expect(hasUnpairedSurrogate(bounded)).toBe(false);
    expect(hasUnpairedSurrogate(cardContent)).toBe(false);
    expect(bounded).toContain('😀tail');
  });

  it('does not split surrogate pairs in truncated terminal errors', () => {
    const card = renderCard({
      ...initialState,
      terminal: 'error',
      errorMsg: `${'a'.repeat(1999)}😀tail`,
    }) as { body?: { elements?: Array<{ content?: string }> } };
    const errorContent = card.body?.elements?.at(-1)?.content ?? '';

    expect(errorContent).toContain('agent 失败');
    expect(hasUnpairedSurrogate(errorContent)).toBe(false);
  });

  it('keeps cards within a conservative element budget', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 80; i += 1) {
      events.push({ type: 'text', delta: `phase-${i}` });
      events.push({
        type: 'tool_use',
        id: `tool-${i}`,
        name: 'Read',
        input: { file_path: `/tmp/${i}` },
      });
      events.push({ type: 'tool_result', id: `tool-${i}`, output: 'ok', isError: false });
    }
    events.push({ type: 'text', delta: 'final-answer' });
    events.push({ type: 'done', terminationReason: 'normal' });

    const card = renderCard(stateFrom(events)) as { body?: { elements?: object[] } };
    const serialized = JSON.stringify(card);

    expect(card.body?.elements?.length).toBeLessThanOrEqual(10);
    expect(serialized).toContain('过程块已折叠');
    expect(serialized).toContain('final-answer');
    expect(getCardPayloadViolation(card)).toBeUndefined();
  });

  it('bounds collapsed tool summaries while preserving recent tools', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 150; i += 1) {
      events.push({
        type: 'tool_use',
        id: `tool-${i}`,
        name: 'Bash',
        input: { command: `echo ${i} ${'x'.repeat(80)}` },
      });
      events.push({ type: 'tool_result', id: `tool-${i}`, output: 'ok', isError: false });
    }
    events.push({ type: 'done', terminationReason: 'normal' });

    const serialized = JSON.stringify(renderCard(stateFrom(events)));

    expect(serialized).toContain('工具调用已省略');
    expect(serialized).toContain('echo 149');
    expect(serialized.length).toBeLessThan(10_000);
    expect(getCardPayloadViolation(renderCard(stateFrom(events)))).toBeUndefined();
  });

  it('rejects cards with too many markdown tables before sending', () => {
    const tables = Array.from(
      { length: 4 },
      (_, i) => `table ${i}\n\n| key | value |\n| --- | --- |\n| a | b |`,
    ).join('\n\n');
    const card = renderCard(stateFrom([
      { type: 'text', delta: tables },
      { type: 'done', terminationReason: 'normal' },
    ]));

    expect(getCardPayloadViolation(card)).toContain('markdown tables');
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
