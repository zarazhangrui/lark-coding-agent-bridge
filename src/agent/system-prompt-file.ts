import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SystemPromptFile {
  path: string;
  cleanup: () => void;
}

/**
 * Persist an appended system prompt to a throwaway temp file so it can be
 * passed as a path instead of argv. Windows agents that resolve through
 * `cmd.exe` would otherwise mangle XML / `<` / `>` characters in the prompt.
 *
 * Returns the path plus an idempotent, best-effort cleanup that removes the
 * temp directory.
 */
export function writeSystemPromptFile(
  content: string,
  options: { prefix?: string; filename?: string } = {},
): SystemPromptFile {
  const dir = mkdtempSync(join(tmpdir(), options.prefix ?? 'lark-channel-'));
  const path = join(dir, options.filename ?? 'append-system-prompt.md');
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}
