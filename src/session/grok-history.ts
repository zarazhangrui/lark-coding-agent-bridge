import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeSessionPreview } from './preview';
import type { SessionSummary } from './history';

function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override ? override : join(homedir(), '.grok');
}

function grokSessionGroupDir(cwd: string): string {
  return join(grokHome(), 'sessions', encodeURIComponent(cwd));
}

/** Return the most recent `limit` Grok sessions for the given cwd, newest first. */
export async function listRecentGrokSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const dir = grokSessionGroupDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const summaries = (
    await Promise.all(entries.map((name) => readGrokSession(join(dir, name), name)))
  ).filter((entry): entry is SessionSummary => entry !== undefined);

  return summaries.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

async function readGrokSession(dir: string, name: string): Promise<SessionSummary | undefined> {
  const summaryPath = join(dir, 'summary.json');
  let raw: string;
  try {
    const st = await stat(summaryPath);
    if (!st.isFile()) return undefined;
    raw = await readFile(summaryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as {
    info?: { id?: unknown };
    generated_title?: unknown;
    session_summary?: unknown;
    last_turn_summary?: unknown;
    updated_at?: unknown;
    last_active_at?: unknown;
    created_at?: unknown;
    num_messages?: unknown;
    num_chat_messages?: unknown;
  };
  const sessionId =
    typeof record.info?.id === 'string' && record.info.id.trim()
      ? record.info.id.trim()
      : name;
  if (!sessionId) return undefined;
  const previewSource =
    stringField(record.generated_title) ??
    stringField(record.session_summary) ??
    stringField(record.last_turn_summary) ??
    sessionId;
  const mtime =
    parseTimestamp(record.updated_at) ??
    parseTimestamp(record.last_active_at) ??
    parseTimestamp(record.created_at) ??
    0;
  const lineCount =
    numberField(record.num_chat_messages) ?? numberField(record.num_messages) ?? 0;
  return {
    sessionId,
    mtime,
    preview: normalizeSessionPreview(previewSource),
    lineCount,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
