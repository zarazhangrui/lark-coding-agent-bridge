import { describe, expect, it } from 'vitest';
import { buildKimiArgs } from '../../../src/agent/kimi/argv.js';

describe('Kimi argv contract', () => {
  it('builds the stream-json exec argv with the prompt in -p', () => {
    expect(buildKimiArgs({ prompt: 'hello' })).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
    ]);
  });

  it('appends --session when resuming a session', () => {
    expect(buildKimiArgs({ prompt: 'continue', sessionId: 'session_123' })).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--session',
      'session_123',
    ]);
  });

  it('appends -m when a model is selected', () => {
    expect(buildKimiArgs({ prompt: 'hi', model: 'kimi-k2.5' })).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '-m',
      'kimi-k2.5',
    ]);
  });

  it('keeps session before model and omits absent flags', () => {
    expect(
      buildKimiArgs({ prompt: 'hi', sessionId: 'session_1', model: 'kimi-k2.5' }),
    ).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--session',
      'session_1',
      '-m',
      'kimi-k2.5',
    ]);
    expect(buildKimiArgs({ prompt: 'hi' })).not.toContain('--session');
    expect(buildKimiArgs({ prompt: 'hi' })).not.toContain('-m');
  });

  it('never emits permission flags, which are mutually exclusive with -p', () => {
    const args = buildKimiArgs({ prompt: 'hi' });
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--auto');
    expect(args).not.toContain('--plan');
  });
});
