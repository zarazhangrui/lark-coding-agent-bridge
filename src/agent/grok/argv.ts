import type { ClaudePermissionMode } from '../../config/permissions';
import type { SandboxMode } from '../../config/profile-schema';
import { CLAUDE_DEFAULT_PERMISSION_MODE } from '../types';

export interface BuildGrokArgsInput {
  promptFile: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: SandboxMode;
  /** Appended via `grok --rules`. Omit to leave Grok's default agent prompt. */
  rules?: string;
}

/**
 * Map the bridge's Codex-shaped sandbox mode onto a Grok CLI `--sandbox`
 * profile. Full access omits the flag so Grok uses its default (`off`).
 */
export function grokSandboxProfile(sandbox: SandboxMode | undefined): string | undefined {
  if (sandbox === 'read-only') return 'read-only';
  if (sandbox === 'workspace-write') return 'workspace';
  return undefined;
}

export function buildGrokArgs(input: BuildGrokArgsInput): string[] {
  const permissionMode = input.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE;
  const args = [
    '--prompt-file',
    input.promptFile,
    '--output-format',
    'streaming-messages-json',
    '--permission-mode',
    permissionMode,
    '--cwd',
    input.cwd,
    '--no-auto-update',
    '--verbatim',
  ];
  if (input.rules) args.push('--rules', input.rules);
  // A resumed session's sandbox is fixed for its lifetime; passing a different
  // `--sandbox` is refused. Omit the flag on resume so Grok restores the saved
  // profile. Fresh runs still map the bridge access mode.
  if (!input.sessionId) {
    const sandbox = grokSandboxProfile(input.sandbox);
    if (sandbox) args.push('--sandbox', sandbox);
  }
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  return args;
}
