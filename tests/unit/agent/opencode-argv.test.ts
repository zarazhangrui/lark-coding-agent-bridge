import { describe, expect, it } from 'vitest';
import { buildOpenCodeArgs } from '../../../src/agent/opencode/argv.js';

describe('OpenCode argv contract', () => {
  it('builds the fresh run argv without putting the prompt in argv', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo' })).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
      '-',
    ]);
  });
});
