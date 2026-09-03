import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  fetchOpencodeModels,
  isDefaultModel,
  isValidModelSelection,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
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

describe('opencode models', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})));
  });

  it('normalizeModelSelection accepts free-form provider/model for opencode', () => {
    expect(normalizeModelSelection('opencode', 'anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(normalizeModelSelection('opencode', DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('opencode', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolveModelArg returns the provider/model or undefined for default', () => {
    expect(resolveModelArg('opencode', 'anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(resolveModelArg('opencode', DEFAULT_MODEL)).toBeUndefined();
  });

  it('fetchOpencodeModels parses provider/model lines from stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-models-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-opencode-models.mjs');
    await writeFile(bin, '#!/usr/bin/env node\nconsole.log("anthropic/claude-opus-4-8\\nopenai/gpt-5-codex\\nsome-garbage-no-slash");\n', 'utf8');
    await chmod(bin, 0o755);
    const models = await fetchOpencodeModels(bin);
    expect(models).toContainEqual({ value: 'anthropic/claude-opus-4-8', label: 'anthropic/claude-opus-4-8' });
    expect(models).toContainEqual({ value: 'openai/gpt-5-codex', label: 'openai/gpt-5-codex' });
    expect(models.find((m) => m.value === 'some-garbage-no-slash')).toBeUndefined();
  });

  it('fetchOpencodeModels returns [] on failure', async () => {
    const models = await fetchOpencodeModels('/nonexistent/opencode-bin-xyz');
    expect(models).toEqual([]);
  });

  it('isValidModelSelection accepts allowlisted values for claude/codex and rejects free-form', () => {
    expect(isValidModelSelection('claude', 'claude-opus-4-8')).toBe(true);
    expect(isValidModelSelection('claude', DEFAULT_MODEL)).toBe(true);
    expect(isValidModelSelection('claude', '')).toBe(false);
    expect(isValidModelSelection('claude', 'anthropic/claude-opus-4-8')).toBe(false);
    expect(isValidModelSelection('codex', 'gpt-5-codex')).toBe(true);
    expect(isValidModelSelection('codex', 'unknown-model-x')).toBe(false);
  });

  it('isValidModelSelection accepts any non-empty non-default string for opencode', () => {
    expect(isValidModelSelection('opencode', 'anthropic/claude-opus-4-8')).toBe(true);
    expect(isValidModelSelection('opencode', 'deepseek/deepseek-chat')).toBe(true);
    expect(isValidModelSelection('opencode', DEFAULT_MODEL)).toBe(true);
    expect(isValidModelSelection('opencode', '')).toBe(false);
  });
});
