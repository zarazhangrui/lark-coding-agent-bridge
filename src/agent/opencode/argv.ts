import type { AccessMode } from '../../config/permissions';

export interface BuildOpencodeArgsInput {
  cwd: string;
  access: AccessMode;
  /** Session id to resume via `--session`. Omitted on a fresh run. */
  sessionId?: string;
  /** `provider/model` forwarded to `--model`. Omitted uses the opencode default. */
  model?: string;
  /** Concatenated system prompt + user message. Goes on stdin, NOT argv. */
  prompt: string;
}

export function buildOpencodeArgs(input: BuildOpencodeArgsInput): string[] {
  if (input.access !== 'read-only' && input.access !== 'workspace' && input.access !== 'full') {
    throw new Error(`unsafe opencode access mode: ${input.access}`);
  }

  // read-only uses the `plan` agent and never auto-approves (permissions
  // auto-reject in non-interactive mode). full/workspace both use `build`
  // with --auto; OpenCode has no workspace-write middle ground.
  const isReadOnly = input.access === 'read-only';

  const args = [
    'run',
    '--dir',
    input.cwd,
    '--format',
    'json',
    '--agent',
    isReadOnly ? 'plan' : 'build',
  ];
  if (!isReadOnly) args.push('--auto');
  if (input.model) args.push('--model', input.model);
  if (input.sessionId) args.push('--session', input.sessionId);
  // The prompt is passed via stdin by the adapter (Windows argv safety),
  // so it never appears in argv. opencode run reads stdin automatically when
  // stdin is not a TTY, so no positional arg or `-` sentinel is needed.
  // We do NOT append the prompt here.
  return args;
}
