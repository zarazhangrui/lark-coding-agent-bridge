import { describe, expect, it } from 'vitest';
import { buildKimiArgs } from '../../../src/agent/kimi/argv.js';

describe('kimi argv contract', () => {
  it('builds a new-session argv with agent file and prompt', () => {
    expect(
      buildKimiArgs({ prompt: 'hello', agentFile: '/tmp/bridge-agent.md' }),
    ).toEqual([
      '--agent-file',
      '/tmp/bridge-agent.md',
      '--output-format',
      'stream-json',
      '--prompt',
      'hello',
    ]);
  });

  it('resumes with --session and never combines it with --agent-file', () => {
    // kimi rejects --agent-file on resume; a resumed session restores the
    // agent bound at creation, so the caller must omit it.
    expect(
      buildKimiArgs({ prompt: 'next', sessionId: 'session_abc' }),
    ).toEqual([
      '--session',
      'session_abc',
      '--output-format',
      'stream-json',
      '--prompt',
      'next',
    ]);
  });

  it('forwards the model selection and never emits permission flags', () => {
    const args = buildKimiArgs({ prompt: 'hi', model: 'kimi-code/kimi-for-coding' });
    expect(args).toContain('--model');
    expect(args).toContain('kimi-code/kimi-for-coding');
    // kimi -p always runs under auto permission; --yolo/--auto are rejected
    // in print mode and must never be emitted.
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--auto');
  });
});
