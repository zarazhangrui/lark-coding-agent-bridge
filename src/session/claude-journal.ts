import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeProjectDir } from './claude-paths';

export interface ClaudeJournalPatchResult {
  path: string;
  changed: boolean;
  rewrittenEntries: number;
}

export async function makeClaudeSessionCliResumable(
  cwd: string,
  sessionId: string,
  homeDir?: string,
): Promise<ClaudeJournalPatchResult> {
  // Claude's resume picker treats `entrypoint: "cli"` as a user-facing
  // conversation. Print-mode persists bridge runs as `sdk-cli`, so normalize
  // the persisted transcript after the child process has closed the journal.
  const path = join(claudeProjectDir(cwd, homeDir), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, changed: false, rewrittenEntries: 0 };
    }
    throw err;
  }

  let rewrittenEntries = 0;
  const lines = text.split('\n').map((line) => {
    if (!line) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isRecord(parsed)) return line;
    if (parsed.sessionId !== sessionId || parsed.entrypoint !== 'sdk-cli') return line;
    parsed.entrypoint = 'cli';
    rewrittenEntries++;
    return JSON.stringify(parsed);
  });

  if (rewrittenEntries === 0) {
    return { path, changed: false, rewrittenEntries: 0 };
  }

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, lines.join('\n'), 'utf8');
  await rename(tmpPath, path);
  return { path, changed: true, rewrittenEntries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
