import { describe, expect, it } from 'vitest';
import { buildTraeArgs, sandboxToTraePermissionMode } from '../../../src/agent/trae/argv.js';

describe('Trae argv contract', () => {
  it('builds fresh exec argv with the prompt on stdin', () => {
    expect(buildTraeArgs({ cwd: '/repo', sandbox: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--permission-mode',
      'plan',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('uses the Trae resume subcommand for thread continuation', () => {
    expect(
      buildTraeArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: '019ef7db-d096-7490-8aba-d7eeafd4f2da',
      }),
    ).toEqual([
      'exec',
      'resume',
      '--json',
      '--permission-mode',
      'default',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '019ef7db-d096-7490-8aba-d7eeafd4f2da',
      '-',
    ]);
  });

  it('passes image flags before the stdin prompt marker', () => {
    expect(
      buildTraeArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--permission-mode',
      'default',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--image',
      '/tmp/image.png',
      '--',
      '-',
    ]);
  });

  it('can explicitly isolate Trae from the user config', () => {
    expect(
      buildTraeArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        ignoreUserConfig: true,
      }),
    ).toContain('--ignore-user-config');
  });

  it('does not combine Trae permission mode with sandbox mode', () => {
    const args = buildTraeArgs({ cwd: '/repo', sandbox: 'danger-full-access' });

    expect(args).toContain('--permission-mode');
    expect(args).not.toContain('--sandbox');
  });

  it('maps bridge sandbox policy to Trae resume permission mode', () => {
    expect(sandboxToTraePermissionMode('read-only')).toBe('plan');
    expect(sandboxToTraePermissionMode('workspace-write')).toBe('default');
    expect(sandboxToTraePermissionMode('danger-full-access')).toBe('bypass_permissions');
  });
});
