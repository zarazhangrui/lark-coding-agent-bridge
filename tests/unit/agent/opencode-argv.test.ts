import { describe, expect, it } from 'vitest';
import { buildOpencodeArgs } from '../../../src/agent/opencode/argv.js';

describe('buildOpencodeArgs', () => {
  it('builds a fresh read-only run with plan agent and no --auto', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'read-only', prompt: 'hi' })).toEqual([
      'run',
      '--dir',
      '/repo',
      '--format',
      'json',
      '--agent',
      'plan',
    ]);
  });

  it('uses build agent with --auto for full access', () => {
    const args = buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' });
    expect(args).toEqual([
      'run',
      '--dir',
      '/repo',
      '--format',
      'json',
      '--agent',
      'build',
      '--auto',
    ]);
  });

  it('treats workspace identically to full (no workspace-write middle ground)', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'workspace', prompt: 'hi' })).toEqual(
      buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' }),
    );
  });

  it('forwards --session when a sessionId is provided', () => {
    const args = buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi', sessionId: 'sess-123' });
    expect(args).toContain('--session');
    expect(args[args.indexOf('--session') + 1]).toBe('sess-123');
  });

  it('forwards --model provider/model when a model is provided', () => {
    const args = buildOpencodeArgs({
      cwd: '/repo',
      access: 'full',
      prompt: 'hi',
      model: 'anthropic/claude-opus-4-8',
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-opus-4-8');
  });

  it('omits --model when no model is provided', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' })).not.toContain('--model');
  });

  it('rejects an invalid access mode', () => {
    expect(() => buildOpencodeArgs({ cwd: '/repo', access: 'bogus' as never, prompt: 'hi' })).toThrow();
  });
});
