import { describe, it, expect } from 'vitest';
import {
  windowState,
  initialState,
  type RunState,
  type Block,
  type ToolEntry,
} from '../../../src/card/run-state';

function toolBlock(id: string, name: string): Block {
  return { kind: 'tool', tool: { id, name, input: {}, status: 'done' } };
}

function textBlock(content: string, streaming = false): Block {
  return { kind: 'text', content, streaming };
}

function stateWith(blocks: Block[]): RunState {
  return { ...initialState, blocks };
}

describe('windowState', () => {
  const opts = { maxTools: 3, maxTextChars: 1000 };

  it('U1: empty state unchanged, truncated false', () => {
    const out = windowState(initialState, opts);
    expect(out.blocks).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('U2: tools <= maxTools all kept, no summary', () => {
    const s = stateWith([toolBlock('1', 'Read'), toolBlock('2', 'Grep'), toolBlock('3', 'Bash')]);
    const out = windowState(s, opts);
    expect(out.blocks.length).toBe(3);
    expect(out.blocks.every((b) => b.kind === 'tool')).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it('U3: tools > maxTools collapse oldest into summary, keep latest', () => {
    const s = stateWith([
      toolBlock('1', 'Read'),
      toolBlock('2', 'Grep'),
      toolBlock('3', 'Bash'),
      toolBlock('4', 'Edit'),
      toolBlock('5', 'Write'),
    ]);
    const out = windowState(s, opts);
    const toolBlocks = out.blocks.filter((b) => b.kind === 'tool') as {
      kind: 'tool';
      tool: ToolEntry;
    }[];
    expect(toolBlocks.length).toBe(3);
    expect(toolBlocks.map((b) => b.tool.id)).toEqual(['3', '4', '5']);
    const summary = out.blocks.find(
      (b) => b.kind === 'text' && b.content.includes('earlier tool calls'),
    ) as { kind: 'text'; content: string } | undefined;
    expect(summary).toBeTruthy();
    expect(summary!.content).toContain('2');
  });

  it('U4: text under maxTextChars unchanged, truncated false', () => {
    const s = stateWith([textBlock('a'.repeat(100))]);
    const out = windowState(s, opts);
    expect((out.blocks[0] as { kind: 'text'; content: string }).content).toBe('a'.repeat(100));
    expect(out.truncated).toBe(false);
  });

  it('U5: text over maxTextChars trimmed to latest, truncated true', () => {
    const s = stateWith([textBlock('a'.repeat(600) + 'b'.repeat(600))]);
    const out = windowState(s, opts);
    const txt = (out.blocks[0] as { kind: 'text'; content: string }).content;
    expect(txt.length).toBeLessThanOrEqual(1100);
    expect(txt).toContain('b');
    expect(out.truncated).toBe(true);
  });

  it('U6: mixed text/tool order preserved among retained blocks', () => {
    const s = stateWith([
      textBlock('hello'),
      toolBlock('1', 'Read'),
      textBlock('world'),
      toolBlock('2', 'Grep'),
    ]);
    const out = windowState(s, opts);
    expect(out.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text', 'tool']);
    expect(out.truncated).toBe(false);
  });
});
