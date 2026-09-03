import { describe, expect, it } from 'vitest';
import { buildMimoArgs } from '../../../src/agent/mimo/argv.js';

describe('buildMimoArgs', () => {
  it('builds a minimal fresh run', () => {
    expect(buildMimoArgs({ cwd: '/work' })).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/work',
    ]);
  });

  it('forwards session, model, thinking, and permissions', () => {
    expect(
      buildMimoArgs({
        cwd: '/work',
        sessionId: 'ses_abc',
        model: 'newapi/deepseek-v4-flash',
        thinking: true,
        skipPermissions: true,
      }),
    ).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--thinking',
      '--model',
      'newapi/deepseek-v4-flash',
      '--session',
      'ses_abc',
      '--dir',
      '/work',
    ]);
  });

  it('omits optional flags by default', () => {
    const args = buildMimoArgs({ cwd: '/work' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--thinking');
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--model');
  });

  it('passes image paths as --file', () => {
    const args = buildMimoArgs({ cwd: '/work', images: ['/tmp/a.png', '/tmp/b.jpg'] });
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--file',
      '/tmp/a.png',
      '--file',
      '/tmp/b.jpg',
      '--dir',
      '/work',
    ]);
  });

  it('never puts the prompt in argv', () => {
    const args = buildMimoArgs({ cwd: '/work' });
    expect(args.join(' ')).not.toContain('<bridge_context>');
  });
});
