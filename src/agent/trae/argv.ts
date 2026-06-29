import type { SandboxMode } from '../../config/profile-schema';

export type TraePermissionMode = 'plan' | 'default' | 'bypass_permissions';

export interface BuildTraeArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export function buildTraeArgs(input: BuildTraeArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const commonFlags = [
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
  ];
  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      'resume',
      '--json',
      '--permission-mode',
      sandboxToTraePermissionMode(input.sandbox),
      ...commonFlags,
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    '--permission-mode',
    sandboxToTraePermissionMode(input.sandbox),
    ...commonFlags,
    '-C',
    input.cwd,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}

export function sandboxToTraePermissionMode(sandbox: SandboxMode): TraePermissionMode {
  switch (sandbox) {
    case 'read-only':
      return 'plan';
    case 'workspace-write':
      return 'default';
    case 'danger-full-access':
      return 'bypass_permissions';
  }
}
