import { describe, it, expect } from 'vitest';
import {
  finalReplyText,
  buildCompletionNotice,
  initialState,
  type RunState,
  type Block,
} from '../../../src/card/run-state';

function toolBlock(id: string, name: string): Block {
  return { kind: 'tool', tool: { id, name, input: {}, status: 'done' } };
}

function textBlock(content: string): Block {
  return { kind: 'text', content, streaming: false };
}

function stateWith(blocks: Block[]): RunState {
  return { ...initialState, blocks };
}

describe('finalReplyText', () => {
  it('UT-001: single text block returns that text', () => {
    const s = stateWith([textBlock('hi')]);
    expect(finalReplyText(s)).toBe('hi');
  });

  it('UT-002: text after the last tool is the reply', () => {
    const s = stateWith([textBlock('narration'), toolBlock('1', 'Read'), textBlock('reply')]);
    expect(finalReplyText(s)).toBe('reply');
  });

  it('UT-003: multiple text blocks after the last tool are joined with newline', () => {
    const s = stateWith([
      textBlock('narration'),
      toolBlock('1', 'Read'),
      textBlock('a'),
      textBlock('b'),
    ]);
    expect(finalReplyText(s)).toBe('a\nb');
  });

  it('UT-004: no text blocks returns undefined', () => {
    const s = stateWith([toolBlock('1', 'Read')]);
    expect(finalReplyText(s)).toBeUndefined();
  });

  it('UT-005: no tool blocks returns all text', () => {
    const s = stateWith([textBlock('only')]);
    expect(finalReplyText(s)).toBe('only');
  });

  it('UT-006: final reply over maxTextChars is head-truncated with a /last hint', () => {
    const s = stateWith([toolBlock('1', 'Read'), textBlock('abcdefghij')]);
    expect(finalReplyText(s, { maxTextChars: 5 })).toBe('abcde（/last 查看完整）');
  });

  it('does not mutate the input state (pure function)', () => {
    const s = stateWith([textBlock('narration'), toolBlock('1', 'Read'), textBlock('reply')]);
    const snapshot = JSON.stringify(s);
    finalReplyText(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('buildCompletionNotice', () => {
  it('UT-007: not truncated → completion line without /last', () => {
    const out = buildCompletionNotice({ mins: 8, toolCount: 18, truncated: false });
    expect(out).toContain('✅ 完成 · 耗时 8m · 18 工具');
    expect(out).toContain('/doctor 查详情');
    expect(out).not.toContain('/last');
  });

  it('UT-008: truncated → appends /last recall hint', () => {
    const out = buildCompletionNotice({ mins: 8, toolCount: 18, truncated: true });
    expect(out).toContain('输出较长，回复 /last 查看完整');
  });
});
