import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT,
  isDefaultEffort,
  resolveEffortArg,
  resolveModelArg,
  supportedEfforts,
  supportedModels,
} from '../../../src/agent/models.js';

describe('model catalog', () => {
  it('offers Fable 5 and Opus 5 to Claude profiles', () => {
    const values = supportedModels('claude').map((m) => m.value);
    expect(values).toContain('claude-fable-5');
    expect(values).toContain('claude-opus-5');
  });

  it('forwards a catalogued model verbatim', () => {
    expect(resolveModelArg('claude', 'claude-fable-5')).toBe('claude-fable-5');
  });

  it('drops an uncatalogued model rather than forwarding it', () => {
    // The silent-coercion trap: a model written straight into config.json but
    // missing from the catalog is dropped, and the run quietly uses the
    // account default instead of erroring.
    expect(resolveModelArg('claude', 'claude-not-a-model')).toBeUndefined();
  });

  it('does not offer Claude models to a codex profile', () => {
    expect(supportedModels('codex').map((m) => m.value)).not.toContain('claude-fable-5');
  });
});

describe('reasoning effort', () => {
  it('accepts every level the claude CLI documents', () => {
    const values = supportedEfforts('claude').map((e) => e.value);
    expect(values).toEqual([DEFAULT_EFFORT, 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('forwards a valid level', () => {
    expect(resolveEffortArg('claude', 'xhigh')).toBe('xhigh');
    expect(resolveEffortArg('claude', 'max')).toBe('max');
  });

  it('omits the flag for the default sentinel and for unset', () => {
    expect(resolveEffortArg('claude', DEFAULT_EFFORT)).toBeUndefined();
    expect(resolveEffortArg('claude', undefined)).toBeUndefined();
    expect(isDefaultEffort(undefined)).toBe(true);
  });

  it('drops an invalid level instead of forwarding it', () => {
    // `claude --effort bogus` exits non-zero, which would fail the whole run —
    // omitting the flag degrades to the default instead.
    expect(resolveEffortArg('claude', 'ultra')).toBeUndefined();
    expect(resolveEffortArg('claude', 'XHIGH')).toBeUndefined();
  });

  it('never forwards effort for codex, which has no such flag', () => {
    expect(supportedEfforts('codex')).toEqual([]);
    expect(resolveEffortArg('codex', 'xhigh')).toBeUndefined();
  });
});
