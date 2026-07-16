import { describe, expect, it } from 'vitest';
import { buildOpenCodeArgs } from '../../../src/agent/opencode/argv.js';

describe('OpenCode argv contract', () => {
  it('builds a fresh JSON run without auto approval by default', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo' })).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
      '-',
    ]);
  });

  it('passes the resume session before JSON output flags', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo', sessionId: 'ses_123' })).toEqual([
      'run',
      '--session',
      'ses_123',
      '--format',
      'json',
      '--dir',
      '/repo',
      '-',
    ]);
  });

  it('adds --auto only when auto approval is explicitly enabled', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo', autoApprove: false })).not.toContain('--auto');
    expect(buildOpenCodeArgs({ cwd: '/repo', autoApprove: true })).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '--dir',
      '/repo',
      '-',
    ]);
  });
});
