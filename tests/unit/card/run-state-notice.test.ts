import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state.js';

describe('run-state notice', () => {
  it('appends a non-streaming text block and closes streaming text', () => {
    let state = reduce(initialState, { type: 'text', delta: 'partial' });
    state = reduce(state, { type: 'notice', text: '工具 Bash 被自动拒绝：x' });
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: 'text', streaming: false });
    expect(state.blocks[1]).toMatchObject({
      kind: 'text',
      streaming: false,
      content: '_⛔ 工具 Bash 被自动拒绝：x_',
    });
  });
});
