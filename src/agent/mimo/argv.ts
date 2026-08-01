export interface BuildMimoArgsInput {
  cwd: string;
  sessionId?: string;
  model?: string;
  thinking?: boolean;
  skipPermissions?: boolean;
  images?: readonly string[];
}

/**
 * Build the `mimo run` argv. The prompt is not part of argv — it is fed on
 * stdin (mimo reads the message from stdin), so special characters never
 * reach the shell. `--format json` emits JSONL events on stdout.
 */
export function buildMimoArgs(input: BuildMimoArgsInput): string[] {
  const args = ['run', '--format', 'json'];
  if (input.skipPermissions) args.push('--dangerously-skip-permissions');
  if (input.thinking) args.push('--thinking');
  if (input.model) args.push('--model', input.model);
  if (input.sessionId) args.push('--session', input.sessionId);
  for (const image of input.images ?? []) args.push('--file', image);
  args.push('--dir', input.cwd);
  return args;
}
