import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';
import {
  emptyThinkingTextFilter,
  filterThinkingTextDelta,
  sanitizeThinkingText,
} from '../../../src/card/thinking-text-filter';

describe('thinking text filter', () => {
  it('should strip planning text before an orphan </think> close tag', () => {
    const filter = emptyThinkingTextFilter();
    let content = '';
    for (const chunk of [
      'Let me proceed with the rewrite.',
      ' I will use Edit with substantial replacements.',
      '</think>',
      '我对 PDF 里的 Table 1-6 实际结构有清楚了。',
    ]) {
      const { output, clearPriorInBlock } = filterThinkingTextDelta(filter, chunk);
      content = clearPriorInBlock ? output : content + output;
    }
    expect(content).toBe('我对 PDF 里的 Table 1-6 实际结构有清楚了。');
    expect(content).not.toContain('Let me proceed');
  });

  it('should remove closed thinking blocks in sanitizeThinkingText', () => {
    const raw =
      'prefix<thinking>secret</thinking>suffix <think>x</think> tail';
    expect(sanitizeThinkingText(raw)).toBe('prefixsuffix  tail');
  });

  it('should hide leaked thinking from markdown renderText while keeping the answer', () => {
    const chunks = [
      'Let me start with slide 21.',
      '</think>',
      'Table 1 的核心结果是 -3.72pp。',
    ];
    let state = initialState;
    for (const delta of chunks) {
      state = reduce(state, { type: 'text', delta });
    }
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    const text = renderText(state);
    expect(text).toContain('Table 1 的核心结果是');
    expect(text).not.toContain('Let me start');
    expect(text).not.toContain('redacted_thinking');
  });

  it('should preserve normal answers that do not contain thinking markers', () => {
    const state = reduce(
      reduce(initialState, { type: 'text', delta: '正常回复，没有 thinking 标签。' }),
      { type: 'done', terminationReason: 'normal' },
    );
    expect(renderText(state)).toBe('正常回复，没有 thinking 标签。');
  });
});
