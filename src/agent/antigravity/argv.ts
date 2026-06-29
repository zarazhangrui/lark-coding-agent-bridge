import type { SandboxMode } from '../../config/profile-schema';

export interface BuildAntigravityArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  conversationId?: string;
  model?: string;
  logFile?: string;
}

export function buildAntigravityArgs(input: BuildAntigravityArgsInput): string[] {
  const args = [
    '--print',
    '--add-dir',
    input.cwd,
  ];

  if (input.sandbox === 'danger-full-access') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--sandbox');
  }
  if (input.conversationId) args.push('--conversation', input.conversationId);
  if (input.model) args.push('--model', input.model);
  if (input.logFile) args.push('--log-file', input.logFile);
  return args;
}
