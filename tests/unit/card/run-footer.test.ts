import { describe, expect, it } from 'vitest';
import { prettyModel, renderFooterMeta } from '../../../src/card/run-footer.js';

describe('run footer', () => {
  it('renders context, model, and effort as one line', () => {
    expect(
      renderFooterMeta({ contextTokens: 403_000, model: 'claude-fable-5', effort: 'max' }),
    ).toBe('🧠 403K · Fable 5 · max');
  });

  it('adds a percentage when the CLI reported a context window', () => {
    expect(
      renderFooterMeta({
        contextTokens: 403_000,
        contextWindow: 1_000_000,
        model: 'claude-fable-5',
        effort: 'max',
      }),
    ).toBe('🧠 403K / 40% · Fable 5 · max');
  });

  it('keeps the token count when the window is missing or implausible', () => {
    // The percentage is additive — an untrustworthy window costs the reader the
    // percentage, never the count.
    expect(renderFooterMeta({ contextTokens: 403_000 })).toBe('🧠 403K');
    expect(renderFooterMeta({ contextTokens: 403_000, contextWindow: 0 })).toBe('🧠 403K');
    expect(renderFooterMeta({ contextTokens: 403_000, contextWindow: 1000 })).toBe('🧠 403K');
  });

  it('degrades field by field rather than dropping the footer', () => {
    expect(renderFooterMeta({ model: 'claude-opus-5' })).toBe('🧠 Opus 5');
    expect(renderFooterMeta({ contextTokens: 12_000, effort: 'xhigh' })).toBe('🧠 12K · xhigh');
  });

  it('renders nothing when no field survives', () => {
    expect(renderFooterMeta({})).toBeUndefined();
    expect(renderFooterMeta(undefined)).toBeUndefined();
    expect(renderFooterMeta({ contextTokens: Number.NaN })).toBeUndefined();
    expect(renderFooterMeta({ contextTokens: -5 })).toBeUndefined();
    // Nonsense that would otherwise render as a confident wrong number.
    expect(renderFooterMeta({ contextTokens: 999_000_000 })).toBeUndefined();
  });

  it('scales past a million and shows small counts exactly', () => {
    expect(renderFooterMeta({ contextTokens: 1_250_000 })).toBe('🧠 1.3M');
    expect(renderFooterMeta({ contextTokens: 940 })).toBe('🧠 940');
  });

  it('names a model released after this table was written', () => {
    // Better a plain id than a nameless footer.
    expect(prettyModel('claude-brand-new-9')).toBe('brand-new-9');
    expect(prettyModel('<synthetic>')).toBeUndefined();
    expect(prettyModel(undefined)).toBeUndefined();
  });

  it('cannot be broken out of a single line', () => {
    const footer = renderFooterMeta({
      contextTokens: 1000,
      model: 'ev\nil\u0007',
      effort: 'hi\u0000gh',
    });
    expect(footer).toBe('🧠 1K · evil · high');
    expect(footer).not.toContain('\n');
  });

  it('marks which round of a continuation loop produced this reply', () => {
    // Every round posts its own message, so without this a round-7 progress
    // report is indistinguishable from an answer to whatever was just asked.
    expect(renderFooterMeta({ model: 'claude-fable-5', goalRound: 7, goalMaxRounds: 20 })).toBe(
      '\u{1F9E0} Fable 5 \u00b7 \u{1F501} 7/20',
    );
  });

  it('shows the round alone when no ceiling is known', () => {
    expect(renderFooterMeta({ goalRound: 3 })).toBe('\u{1F9E0} \u{1F501} 3');
  });

  it('says nothing about loops when no loop is running', () => {
    expect(renderFooterMeta({ model: 'claude-fable-5' })).toBe('\u{1F9E0} Fable 5');
    expect(renderFooterMeta({ model: 'claude-fable-5', goalRound: 0 })).toBe('\u{1F9E0} Fable 5');
    // A ceiling below the current round is contradictory \u2014 drop it rather
    // than render "8/5".
    expect(renderFooterMeta({ goalRound: 8, goalMaxRounds: 5 })).toBe('\u{1F9E0} \u{1F501} 8');
  });
});
