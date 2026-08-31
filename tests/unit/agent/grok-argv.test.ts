import { describe, expect, it } from 'vitest';
import { buildGrokArgs, grokSandboxProfile } from '../../../src/agent/grok/argv.js';

describe('buildGrokArgs', () => {
  it('emits a headless prompt-file contract with default permission mode', () => {
    expect(
      buildGrokArgs({
        promptFile: '/tmp/prompt.md',
        cwd: '/repo',
      }),
    ).toEqual([
      '--prompt-file',
      '/tmp/prompt.md',
      '--output-format',
      'streaming-messages-json',
      '--permission-mode',
      'bypassPermissions',
      '--cwd',
      '/repo',
      '--no-auto-update',
      '--verbatim',
    ]);
  });

  it('appends rules and mapped sandbox on a fresh run', () => {
    expect(
      buildGrokArgs({
        promptFile: '/tmp/prompt.md',
        cwd: '/repo',
        permissionMode: 'acceptEdits',
        sandbox: 'workspace-write',
        rules: 'bridge rules',
      }),
    ).toEqual([
      '--prompt-file',
      '/tmp/prompt.md',
      '--output-format',
      'streaming-messages-json',
      '--permission-mode',
      'acceptEdits',
      '--cwd',
      '/repo',
      '--no-auto-update',
      '--verbatim',
      '--rules',
      'bridge rules',
      '--sandbox',
      'workspace',
    ]);
  });

  it('omits --sandbox on resume so Grok restores the session profile', () => {
    const args = buildGrokArgs({
      promptFile: '/tmp/prompt.md',
      cwd: '/repo',
      sessionId: 'sess-1',
      model: 'grok-4.6',
      sandbox: 'workspace-write',
    });
    expect(args).not.toContain('--sandbox');
    expect(args.slice(-4)).toEqual(['--resume', 'sess-1', '--model', 'grok-4.6']);
  });

  it('maps sandbox modes onto Grok profiles and omits full access', () => {
    expect(grokSandboxProfile('read-only')).toBe('read-only');
    expect(grokSandboxProfile('workspace-write')).toBe('workspace');
    expect(grokSandboxProfile('danger-full-access')).toBeUndefined();
    expect(grokSandboxProfile(undefined)).toBeUndefined();
  });
});
