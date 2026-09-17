export interface BuildKimiArgsInput {
  /** The full prompt (bridge system prompt is NOT in here — it goes via agentFile). */
  prompt: string;
  /** Resume an existing session (`kimi --session <id>`). Omit to start a new one. */
  sessionId?: string;
  /** Forwarded to `kimi --model`. Omitted uses the configured default model. */
  model?: string;
  /**
   * Bridge agent file injected via `--agent-file`. New sessions only: kimi
   * rejects `--agent-file` combined with `--session`, and a resumed session
   * restores the agent it was bound to at creation, so resuming must not
   * pass it.
   */
  agentFile?: string;
}

/**
 * Build the kimi CLI argv for one non-interactive run.
 *
 * Always uses `-p/--prompt ... --output-format stream-json`. Note that kimi
 * rejects `--prompt` combined with `--yolo`/`--auto`/`--plan`: print mode
 * always runs under the auto permission policy, so there is deliberately no
 * permission flag here (AccessMode mapping cannot be expressed in -p mode).
 */
export function buildKimiArgs(input: BuildKimiArgsInput): string[] {
  const args: string[] = [];
  if (input.sessionId) {
    args.push('--session', input.sessionId);
  } else if (input.agentFile) {
    args.push('--agent-file', input.agentFile);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  args.push('--output-format', 'stream-json', '--prompt', input.prompt);
  return args;
}
