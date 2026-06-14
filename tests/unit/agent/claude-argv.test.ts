import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../../src/agent/claude/argv.js';

describe('Claude argv contract', () => {
  it('builds the text path with the prompt in argv', () => {
    expect(
      buildClaudeArgs({ prompt: 'hello', systemPrompt: 'SYS' }),
    ).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      'SYS',
    ]);
  });

  it('builds the stream-json path without the prompt in argv', () => {
    const args = buildClaudeArgs({ prompt: 'hello', systemPrompt: 'SYS', streamJson: true });
    expect(args.slice(0, 3)).toEqual(['-p', '--input-format', 'stream-json']);
    // The prompt travels via stdin on this path, never argv.
    expect(args).not.toContain('hello');
    expect(args).toContain('--output-format');
    expect(args).toContain('--append-system-prompt');
  });

  it('honours an explicit permission mode', () => {
    const args = buildClaudeArgs({ prompt: 'x', systemPrompt: 'SYS', permissionMode: 'default' });
    const i = args.indexOf('--permission-mode');
    expect(args[i + 1]).toBe('default');
  });

  it('appends resume and model flags in order when present', () => {
    const args = buildClaudeArgs({
      prompt: 'x',
      systemPrompt: 'SYS',
      sessionId: 'sess-1',
      model: 'opus',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('omits resume and model flags when absent', () => {
    const args = buildClaudeArgs({ prompt: 'x', systemPrompt: 'SYS' });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
  });
});
