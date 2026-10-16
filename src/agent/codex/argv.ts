import type { SandboxMode } from '../../config/profile-schema';
import type { CodexApprovalMode } from '../../config/permissions';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  approvalMode?: CodexApprovalMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  // Preserve existing profiles' never policy unless auto-review is opted into.
  const approvalFlags = input.approvalMode === 'auto-review'
    ? ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']
    : ['-c', 'approval_policy="never"'];

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...approvalFlags,
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
