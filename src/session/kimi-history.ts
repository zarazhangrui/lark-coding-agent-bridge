import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from './history';

interface KimiSessionIndexEntry {
  sessionId?: unknown;
  sessionDir?: unknown;
  workDir?: unknown;
}

function kimiSessionIndexPath(): string {
  return join(homedir(), '.kimi-code', 'session_index.jsonl');
}

/**
 * Return the most recent `limit` kimi sessions for the given cwd, newest
 * first. Reads `~/.kimi-code/session_index.jsonl` (one JSON per line, entries
 * like `{ "sessionId", "sessionDir", "workDir" }`), keeps entries whose
 * workDir matches the cwd, and uses the session dir's mtime as the sort key.
 */
export async function listKimiSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  let raw: string;
  try {
    raw = await readFile(kimiSessionIndexPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const cwdReal = await realpathIfExists(cwd);

  const matches: Array<{ sessionId: string; mtime: number }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: KimiSessionIndexEntry;
    try {
      entry = JSON.parse(trimmed) as KimiSessionIndexEntry;
    } catch {
      continue; // malformed line
    }
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
    const workDir = typeof entry.workDir === 'string' ? entry.workDir : '';
    const sessionDir = typeof entry.sessionDir === 'string' ? entry.sessionDir : '';
    if (!sessionId || !sessionDir) continue;
    if (workDir !== cwd && workDir !== cwdReal) continue;
    const mtime = await dirMtime(sessionDir);
    if (mtime !== undefined) matches.push({ sessionId, mtime });
  }

  return matches
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((entry) => ({
      sessionId: entry.sessionId,
      mtime: entry.mtime,
      preview: '(kimi 会话)',
      lineCount: 0,
    }));
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function dirMtime(dir: string): Promise<number | undefined> {
  try {
    const st = await stat(dir);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}
