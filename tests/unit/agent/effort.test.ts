import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT,
  effortLabel,
  normalizeEffortSelection,
  resolveEffortArg,
  supportedEfforts,
} from '../../../src/agent/effort.js';

describe('Claude effort selection', () => {
  it('offers an unspecified default and the five Claude effort levels', () => {
    expect(supportedEfforts().map((option) => option.value)).toEqual([
      DEFAULT_EFFORT, 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('leaves the CLI default in control until an effort is selected', () => {
    expect(resolveEffortArg('claude', undefined)).toBeUndefined();
    expect(resolveEffortArg('claude', DEFAULT_EFFORT)).toBeUndefined();
    expect(effortLabel(undefined)).toContain('跟随默认');
  });

  it('preserves explicit levels, including persistent max', () => {
    for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(normalizeEffortSelection(value)).toBe(value);
      expect(resolveEffortArg('claude', value)).toBe(value);
    }
  });

  it('ignores unsupported input and never forwards a Claude setting to Codex', () => {
    expect(normalizeEffortSelection('max --permission-mode bypassPermissions')).toBe(DEFAULT_EFFORT);
    expect(normalizeEffortSelection('ultracode')).toBe(DEFAULT_EFFORT);
    expect(resolveEffortArg('claude', 'invalid')).toBeUndefined();
    expect(resolveEffortArg('codex', 'max')).toBeUndefined();
  });
});
