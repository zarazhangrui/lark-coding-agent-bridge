import { describe, expect, it } from 'vitest';
import {
  emptyThinkingTextFilter,
  filterThinkingTextDelta,
  sanitizeThinkingText,
} from '../../../src/card/thinking-text-filter';
import { initialState, reduce } from '../../../src/card/run-state';

const RT = 'redacted_' + 'thinking';
const RT_CLOSE = '</' + RT + '>';

describe('thinking-text-filter', () => {
  it('strips orphaned closing tag and keeps visible answer', () => {
    const filter = emptyThinkingTextFilter();
    const chunks = [
      "Let me proceed with the rewrite. I'll be efficient by using Edit",
      ' with substantial old_string replacements.',
      RT_CLOSE,
      '我对 PDF 里的 Table 1-6 实际结构有清楚了。现在开始按 PDF 的真实表格结构重写。',
    ];

    let content = '';
    for (const chunk of chunks) {
      const { output, clearPriorInBlock } = filterThinkingTextDelta(filter, chunk);
      content = clearPriorInBlock ? output : content + output;
    }

    expect(content).not.toContain('Let me proceed');
    expect(content).toContain('我对 PDF');
  });

  it('sanitizeThinkingText removes full thinking blocks', () => {
    const text = '<thinking>secret</thinking>visible tail';
    expect(sanitizeThinkingText(text)).toBe('visible tail');
    expect(sanitizeThinkingText('prefix' + RT_CLOSE + 'suffix')).toBe('suffix');
  });

  it('reduce keeps only visible answer when thinking tags leak into text events', () => {
    let state = initialState;
    state = reduce(state, {
      type: 'text',
      delta: "Let me proceed with the rewrite. I'll be efficient by using Edit",
    });
    state = reduce(state, {
      type: 'text',
      delta: ' with substantial old_string replacements.',
    });
    state = reduce(state, { type: 'text', delta: RT_CLOSE });
    state = reduce(state, {
      type: 'text',
      delta: '我对 PDF 里的 Table 1-6 实际结构有清楚了。现在开始按 PDF 的真实表格结构重写。',
    });
    state = reduce(state, { type: 'done', terminationReason: 'normal' });

    const textBlock = state.blocks.find((b) => b.kind === 'text');
    expect(textBlock?.kind).toBe('text');
    if (textBlock?.kind === 'text') {
      expect(textBlock.content).not.toContain('Let me proceed');
      expect(textBlock.content).toContain('我对 PDF');
    }
  });
});
