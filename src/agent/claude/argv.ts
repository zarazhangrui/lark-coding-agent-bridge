import { CLAUDE_DEFAULT_PERMISSION_MODE, type ClaudePermissionMode } from '../types';

export interface BuildClaudeArgsInput {
  /** The user prompt. Only placed in argv on the text path; on the
   *  stream-json path it travels via stdin instead, so it's omitted here. */
  prompt: string;
  systemPrompt: string;
  permissionMode?: ClaudePermissionMode;
  sessionId?: string;
  model?: string;
  /** When true, read the user message from stdin as stream-json (the image
   *  path) instead of passing `-p <prompt>` in argv (the text path). */
  streamJson?: boolean;
}

export function buildClaudeArgs(input: BuildClaudeArgsInput): string[] {
  // Both paths share everything except how the prompt is delivered: the
  // text path puts it in argv (`-p <prompt>`), the stream-json path leaves
  // `-p` bare and feeds the prompt + images over stdin.
  const promptArgs = input.streamJson ? ['-p', '--input-format', 'stream-json'] : ['-p', input.prompt];

  const args = [
    ...promptArgs,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    input.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
    '--append-system-prompt',
    input.systemPrompt,
  ];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  return args;
}
