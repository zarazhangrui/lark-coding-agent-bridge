import { join } from 'node:path';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { normalizeSessionPreview } from './preview';
import { log } from '../core/logger';

export interface OpencodeSessionHistoryEntry {
  sessionId: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ListOpencodeSessionHistoryOptions {
  binary: string;
  cwd: string;
  limit: number;
  /** Profile state dir; used to construct OPENCODE_CONFIG_DIR when config isolation is enabled. */
  profileStateDir?: string;
  /** When false, OPENCODE_CONFIG_DIR points at <profileStateDir>/opencode-config. */
  inheritConfig?: boolean;
  timeoutMs?: number;
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;

/**
 * List recent opencode sessions via `opencode session list --format json -n N`.
 * Filters to sessions whose `directory` matches the given cwd (opencode sessions
 * are scoped to a project directory). Returns [] on any failure.
 */
export async function listOpencodeSessionHistory(
  options: ListOpencodeSessionHistoryOptions,
): Promise<OpencodeSessionHistoryEntry[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;

  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.profileStateDir && options.inheritConfig === false) {
    envOverrides.OPENCODE_CONFIG_DIR = join(options.profileStateDir, 'opencode-config');
  }
  const spawnOpts: { stdio: ['ignore', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv } = {
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (Object.keys(envOverrides).length > 0) {
    spawnOpts.env = mergeProcessEnv(process.env, envOverrides);
  }

  const child = spawnProcess(
    options.binary,
    ['session', 'list', '--format', 'json', '-n', String(options.limit * 3)],
    spawnOpts,
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);

  let exitCode: number | null = null;
  try {
    [exitCode] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, sig) => resolve([code, sig]));
    });
  } catch {
    clearTimeout(timeout);
    return [];
  }
  clearTimeout(timeout);

  if (exitCode !== 0) {
    log.warn('session-history', 'opencode-list-nonzero', { exitCode, stderr: stderr.slice(0, 200) });
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const entries: OpencodeSessionHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : undefined;
    const title = typeof rec.title === 'string' ? rec.title : '';
    const dir = typeof rec.directory === 'string' ? rec.directory : undefined;
    const updated = typeof rec.updated === 'number' ? rec.updated : 0;
    const created = typeof rec.created === 'number' ? rec.created : 0;
    if (!id || !dir) continue;
    // Filter to sessions for this cwd (opencode returns global sessions).
    if (dir !== options.cwd) continue;
    entries.push({
      sessionId: id,
      preview: normalizeSessionPreview(title) || '(空会话)',
      cwd: dir,
      createdAtMs: created,
      updatedAtMs: updated,
    });
  }
  // Sort newest-first so the most recent sessions are never skipped.
  entries.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return entries.slice(0, options.limit);
}
