import { describe, expect, it } from 'vitest';
import { buildKimiArgs } from '../../../src/agent/kimi/adapter.js';

describe('buildKimiArgs', () => {
  it('builds prompt-mode stream-json args with prompt only', () => {
    expect(buildKimiArgs({ prompt: 'hello' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
    ]);
  });

  it('adds session flag when sessionId is provided', () => {
    expect(buildKimiArgs({ prompt: 'continue', sessionId: 'session-abc' })).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '-S',
      'session-abc',
    ]);
  });

  it('adds model flag when model is provided', () => {
    expect(buildKimiArgs({ prompt: 'go', model: 'kimi-code/kimi-for-coding' })).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '-m',
      'kimi-code/kimi-for-coding',
    ]);
  });

  it('includes session and model together', () => {
    expect(
      buildKimiArgs({
        prompt: 'continue',
        sessionId: 'session-abc',
        model: 'kimi-code/kimi-for-coding',
      }),
    ).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '-S',
      'session-abc',
      '-m',
      'kimi-code/kimi-for-coding',
    ]);
  });
});
