import { describe, expect, it } from 'vitest';
import {
  CODEX_REASONING_LEVELS,
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  normalizeReasoningEffort,
  reasoningLevelLabel,
  resolveModelArg,
  resolveReasoningEffort,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-6.1-sol');
    expect(claude.map((m) => m.value)).not.toContain('gpt-6.1-sol');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});

describe('codex reasoning effort catalog', () => {
  it('offers the default sentinel plus the five shared levels, without ultra', () => {
    expect(CODEX_REASONING_LEVELS[0]?.value).toBe(DEFAULT_MODEL);
    expect(CODEX_REASONING_LEVELS.map((l) => l.value)).toEqual([
      DEFAULT_MODEL,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('coerces unknown / non-codex effort values back to the default', () => {
    expect(normalizeReasoningEffort('codex', 'xhigh')).toBe('xhigh');
    // `ultra` is model-specific and intentionally not offered.
    expect(normalizeReasoningEffort('codex', 'ultra')).toBe(DEFAULT_MODEL);
    expect(normalizeReasoningEffort('codex', undefined)).toBe(DEFAULT_MODEL);
    expect(normalizeReasoningEffort('claude', 'high')).toBe(DEFAULT_MODEL);
  });

  it('resolves the -c override value, omitting it for the default', () => {
    expect(resolveReasoningEffort('codex', 'high')).toBe('high');
    expect(resolveReasoningEffort('codex', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveReasoningEffort('codex', undefined)).toBeUndefined();
    expect(resolveReasoningEffort('claude', 'high')).toBeUndefined();
  });

  it('labels a stored effort using the picker option text', () => {
    expect(reasoningLevelLabel('codex', 'xhigh')).toBe('超高（xhigh）');
    expect(reasoningLevelLabel('codex', DEFAULT_MODEL)).toContain('跟随默认');
  });
});
