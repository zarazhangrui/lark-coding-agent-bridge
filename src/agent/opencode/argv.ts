export interface BuildOpenCodeArgsInput {
  cwd: string;
  sessionId?: string;
  autoApprove?: boolean;
}

export function buildOpenCodeArgs(input: BuildOpenCodeArgsInput): string[] {
  const args = ['run'];
  if (input.sessionId) {
    args.push('--session', input.sessionId);
  }
  if (input.autoApprove === true) {
    args.push('--auto');
  }
  args.push('--format', 'json', '--dir', input.cwd, '-');
  return args;
}
