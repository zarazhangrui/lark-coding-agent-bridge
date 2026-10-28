import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionSummary } from './history';
import { normalizeSessionPreview } from './preview';

const MAX_SUMMARY_LINES = 20_000;

/**
 * OMP's session bucket name for a canonical cwd (see OMP's `session.md`):
 * `-<relative>` under $HOME, `-tmp-<relative>` under the temp root, and
 * `--<encoded-absolute>--` elsewhere, with separators replaced by `-`.
 */
function encodeSessionCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  const temp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWithin(normalized, home)) {
    return `-${relativeTo(normalized, home).replace(/\//g, '-')}`;
  }
  if (isWithin(normalized, temp)) {
    return `-tmp-${relativeTo(normalized, temp).replace(/\//g, '-')}`;
  }
  return `--${normalized.replace(/^\/+/, '').replace(/\//g, '-')}--`;
}

function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function relativeTo(path: string, base: string): string {
  return path
    .slice(base.length)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * OMP stores sessions under `<agent dir>/sessions/<encoded cwd>/`, one JSONL
 * file per session named `<timestamp>_<session id>.jsonl`. `PI_CODING_AGENT_DIR`
 * relocates the agent dir (tests use it; OMP itself documents it as the
 * override for `~/.omp/agent`).
 */
export function ompSessionsDir(cwd: string): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent');
  return join(agentDir, 'sessions', encodeSessionCwd(cwd));
}

/** Return the most recent `limit` OMP sessions for the given cwd, newest first. */
export async function listOmpResumeHistory(
  cwd: string,
  limit = 5,
): Promise<SessionSummary[]> {
  // OMP buckets by canonical cwd, so symlink aliases share one directory.
  const canonical = await realpath(cwd).catch(() => cwd);
  const dir = ompSessionsDir(canonical);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const withStats = await Promise.all(
    files
      .filter((file) => file.endsWith('.jsonl'))
      .map(async (file) => {
        const path = join(dir, file);
        try {
          const st = await stat(path);
          return { file, path, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const sorted = withStats
    .filter((entry): entry is { file: string; path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const { preview, lineCount } = await summarize(entry.path);
      return {
        sessionId: sessionIdFromFile(entry.file),
        mtime: entry.mtime,
        preview,
        lineCount,
      };
    }),
  );
}

function sessionIdFromFile(file: string): string {
  const base = file.replace(/\.jsonl$/, '');
  const separator = base.lastIndexOf('_');
  return separator === -1 ? base : base.slice(separator + 1);
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"role":"user"')) {
        const text = userTextFromLine(line);
        if (text) preview = normalizeSessionPreview(text);
      }
      if (lineCount > MAX_SUMMARY_LINES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function userTextFromLine(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== 'message') return undefined;
  const message = entry.message;
  if (!isRecord(message) || message.role !== 'user') return undefined;
  // OMP also writes agent-authored user messages (handoffs, reminders).
  if (message.attribution === 'agent') return undefined;
  const content = message.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text = block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    if (text.trim()) return text;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
