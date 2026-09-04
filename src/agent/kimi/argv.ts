export interface BuildKimiArgsInput {
  prompt: string;
  sessionId?: string;
  model?: string;
}

/**
 * Build the argv for a `kimi` CLI run in stream-json output mode.
 *
 * The prompt (already prefixed with the bridge system prompt) goes through
 * `-p` on the argv. macOS spawns `kimi` directly without a shell, so the
 * `<bridge_context>` XML in the prompt is never interpreted. On Windows the
 * `kimi` binary may resolve to a `.cmd` shim routed through cmd.exe, which
 * would treat `<` / `>` as redirection operators — mirror the Codex adapter's
 * stdin/temp-file prompt strategy if Windows support is ever needed.
 *
 * `--yolo` / `--auto` / `--plan` are mutually exclusive with `-p`, so no
 * permission flag is passed here; the kimi adapter ignores sandbox /
 * permissionMode entirely and `/status` displays the access mode instead.
 */
export function buildKimiArgs(input: BuildKimiArgsInput): string[] {
  return [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    ...(input.sessionId ? ['--session', input.sessionId] : []),
    ...(input.model ? ['-m', input.model] : []),
  ];
}
