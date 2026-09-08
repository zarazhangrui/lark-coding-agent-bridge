import { describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { renderFooterMeta } from '../../../src/card/run-footer.js';
import { finalizeIfRunning, initialState, withMeta, type RunState } from '../../../src/card/run-state.js';
import { hasDeliverableContent, renderText } from '../../../src/card/text-renderer.js';

/**
 * A verbatim `result` event from `claude -p --output-format stream-json`,
 * captured from the real CLI. The footer's context number is derived from
 * these exact field names, so this doubles as the contract test: if the CLI
 * renames one, the derived total changes and this fails.
 */
const REAL_RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  total_cost_usd: 0.1001436,
  usage: {
    // Top-level totals: summed over every request the agentic loop made.
    input_tokens: 8,
    cache_creation_input_tokens: 15_764,
    cache_read_input_tokens: 144_499,
    output_tokens: 895,
    // The final message's own request — the only usable basis for context.
    iterations: [
      {
        input_tokens: 2,
        output_tokens: 678,
        cache_read_input_tokens: 40_113,
        cache_creation_input_tokens: 75,
      },
    ],
  },
  modelUsage: {
    'claude-sonnet-5': { contextWindow: 1_000_000, costUSD: 0.1001436 },
  },
};

/** Mirrors how `processAgentStream` folds usage/system events into the state. */
function foldMeta(state: RunState, evt: AgentEvent): RunState {
  if (evt.type === 'system' && evt.model) return withMeta(state, { model: evt.model });
  if (evt.type === 'usage') {
    // Consumes what the adapter computed — summing the raw fields here is the
    // very mistake that produced a fourfold-high number in the first place.
    return withMeta(state, {
      contextTokens: evt.contextTokens,
      contextWindow: evt.contextWindow,
    });
  }
  return state;
}

describe('footer pipeline', () => {
  it('derives context from every part of the prompt plus the output', () => {
    const [usage] = [...translateEvent(REAL_RESULT)];
    expect(usage).toMatchObject({
      type: 'usage',
      inputTokens: 8,
      cachedInputTokens: 144_499,
      cacheCreationInputTokens: 15_764,
      outputTokens: 895,
      contextWindow: 1_000_000,
    });

    const state = foldMeta(initialState, usage!);
    // Final request only: 2 + 40113 + 75 + 678.
    expect(state.meta?.contextTokens).toBe(40_868);
    expect(renderFooterMeta(state.meta)).toBe('🧠 41K / 4%');
  });

  it('reads the model the CLI actually loaded, not the one requested', () => {
    const [system] = [...translateEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-fable-5',
    })];
    const state = foldMeta(initialState, system!);
    expect(renderFooterMeta(state.meta)).toBe('🧠 Fable 5');
  });

  it('shows the footer on a finished card, behind a divider', () => {
    let state = initialState;
    for (const evt of translateEvent(REAL_RESULT)) state = foldMeta(state, evt);
    state = withMeta(finalizeIfRunning({ ...state, blocks: [{ kind: 'text', content: '好了。', streaming: false }] }), {
      model: 'claude-fable-5',
      effort: 'max',
    });

    const card = renderCard(state) as { body: { elements: Array<Record<string, unknown>> } };
    const json = JSON.stringify(card);
    expect(json).toContain('41K / 4%');
    expect(json).toContain('Fable 5');
    expect(json).toContain('max');
    // Divider immediately precedes the footer note.
    const hrIndex = card.body.elements.findIndex((e) => e.tag === 'hr');
    expect(hrIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(card.body.elements[hrIndex + 1])).toContain('41K');

    expect(renderText(state)).toContain('🧠 41K / 4% · Fable 5 · max');
  });

  it('drops the percentage when the window cannot be attributed', () => {
    // `modelUsage` is keyed by model id and never says which one produced the
    // final message. With more than one, any denominator is a guess — so the
    // token count stands alone rather than carrying a made-up percentage.
    const twoModels = {
      ...REAL_RESULT,
      modelUsage: {
        'claude-sonnet-5': { contextWindow: 1_000_000 },
        'claude-opus-4-8': { contextWindow: 2_000_000 },
      },
    };
    let state = initialState;
    for (const evt of translateEvent(twoModels)) state = foldMeta(state, evt);
    expect(state.meta?.contextWindow).toBeUndefined();
    expect(renderFooterMeta(state.meta)).toBe('🧠 41K');
  });

  it('never reports more context than the window holds', () => {
    // The bug this guards: summing the run's cumulative totals put the number
    // past 1M ("🧠 1.8M") on a 1M-window model.
    let state = initialState;
    for (const evt of translateEvent(REAL_RESULT)) state = foldMeta(state, evt);
    expect(state.meta!.contextTokens!).toBeLessThanOrEqual(state.meta!.contextWindow!);
  });

  it('shows no footer while the run is still going', () => {
    // Usage only arrives with the terminal event, so a running card would be
    // showing the previous turn's number.
    const running = withMeta(
      { ...initialState, blocks: [{ kind: 'text', content: '写…', streaming: true }] },
      { contextTokens: 403_000, model: 'claude-fable-5', effort: 'max' },
    );
    expect(JSON.stringify(renderCard(running))).not.toContain('403K');
    expect(renderText(running)).not.toContain('403K');
  });

  it('does not turn an empty answer into a footer-only message', () => {
    // Observed in production: a turn whose answer went out as a COT bubble left
    // the final reply empty, and the footer made the skip-empty guard think
    // there was something to send — so a message containing nothing but
    // `🧠 Fable 5 · xhigh` was posted on its own.
    const empty = withMeta(finalizeIfRunning({ ...initialState, blocks: [] }), {
      contextTokens: 527_000,
      model: 'claude-fable-5',
      effort: 'xhigh',
    });

    // The footer still renders — it is the emptiness *check* that must ignore it.
    expect(renderText(empty)).toContain('🧠');
    expect(hasDeliverableContent(empty)).toBe(false);
  });

  it('still counts a real answer as deliverable', () => {
    const answered = withMeta(
      finalizeIfRunning({
        ...initialState,
        blocks: [{ kind: 'text', content: '任务已完成', streaming: false }],
      }),
      { contextTokens: 527_000, model: 'claude-fable-5', effort: 'xhigh' },
    );
    expect(hasDeliverableContent(answered)).toBe(true);
  });

  it('renders the reply unchanged when the CLI reports no usage at all', () => {
    const noUsage = [...translateEvent({ type: 'result', session_id: 'sess-1' })];
    expect(noUsage.map((e) => e.type)).toEqual(['done']);

    const state = finalizeIfRunning({
      ...initialState,
      blocks: [{ kind: 'text', content: '答案', streaming: false }],
    });
    expect(renderText(state)).toBe('答案');
    expect(JSON.stringify(renderCard(state))).not.toContain('🧠');
  });
});
