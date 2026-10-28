/**
 * OMP approval mode. The bridge's RPC transport has no approval dialog, so
 * restricted modes would fail closed on every write/exec tool call. Profiles
 * are therefore required to run with full access (see `ompCapability`), which
 * maps to `yolo` here.
 */
export const OMP_APPROVAL_MODE = 'yolo';

export interface BuildOmpArgsInput {
  /** Path to the bridge system prompt file (read by OMP as text). */
  systemPromptFile: string;
  /** Resume an existing OMP session by id instead of starting a fresh one. */
  sessionId?: string;
  /** Forwarded to `--model`; omitted to keep OMP's configured default. */
  model?: string;
  approvalMode?: string;
}

/**
 * Build the argv for one non-interactive OMP RPC run.
 *
 * The user prompt never goes through argv (it is sent as an RPC `prompt`
 * frame), and the bridge system prompt goes through a file path so Windows
 * `cmd.exe` shims cannot interpret XML angle brackets as redirection.
 */
export function buildOmpArgs(input: BuildOmpArgsInput): string[] {
  return [
    '--mode',
    'rpc',
    '--no-title',
    '--approval-mode',
    input.approvalMode ?? OMP_APPROVAL_MODE,
    '--append-system-prompt',
    input.systemPromptFile,
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ...(input.model ? ['--model', input.model] : []),
  ];
}
