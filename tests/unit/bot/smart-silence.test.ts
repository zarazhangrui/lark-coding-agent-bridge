import { describe, expect, it } from 'vitest';
import { isSmartSilentEval } from '../../../src/bot/channel.js';
import { initialState, type RunState } from '../../../src/card/run-state.js';

function state(partial: Partial<RunState>): RunState {
  return { ...initialState, terminal: 'done', ...partial };
}

describe('isSmartSilentEval', () => {
  it('treats the bare sentinel as silence', () => {
    expect(
      isSmartSilentEval(
        state({ blocks: [{ kind: 'text', content: '[[silent]]', streaming: false }] }),
      ),
    ).toBe(true);
  });

  it('treats no text output as silence', () => {
    expect(isSmartSilentEval(state({ blocks: [] }))).toBe(true);
  });

  it('tolerates whitespace / backticks / bold around the sentinel', () => {
    expect(
      isSmartSilentEval(
        state({ blocks: [{ kind: 'text', content: '  `[[silent]]` ', streaming: false }] }),
      ),
    ).toBe(true);
  });

  it('ignores tool-call blocks — a tool-using-but-silent eval is still silent', () => {
    // Regression: renderText would render the tool line and make this look
    // non-silent, leaking the tool trace into the chat.
    expect(
      isSmartSilentEval(
        state({
          blocks: [
            {
              kind: 'tool',
              tool: { id: 't1', name: 'Read', input: { path: 'a.ts' }, status: 'done' },
            },
            { kind: 'text', content: '[[silent]]', streaming: false },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('is NOT silent when the agent produced a real text reply', () => {
    expect(
      isSmartSilentEval(
        state({ blocks: [{ kind: 'text', content: '我来帮你看一下这个问题', streaming: false }] }),
      ),
    ).toBe(false);
  });

  it('is NOT silent when a reply accompanies a tool call', () => {
    expect(
      isSmartSilentEval(
        state({
          blocks: [
            {
              kind: 'tool',
              tool: { id: 't1', name: 'Read', input: {}, status: 'done' },
            },
            { kind: 'text', content: '改好了', streaming: false },
          ],
        }),
      ),
    ).toBe(false);
  });
});
