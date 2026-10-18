import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import type { SessionSummary } from './history';

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;

export interface ListKimiSessionsOptions {
  binary?: string;
  cwd: string;
  limit: number;
  timeoutMs?: number;
}

/**
 * List recent kimi sessions for a working directory via
 * `kimi session list --cwd <cwd> --json` (most recently updated first).
 * Best-effort: any spawn/parse failure yields an empty list so `/resume`
 * degrades to "no history" instead of erroring the chat command.
 */
export async function listKimiResumeHistory(
  options: ListKimiSessionsOptions,
): Promise<SessionSummary[]> {
  const binary = options.binary ?? process.env.LARK_CHANNEL_KIMI_BIN ?? 'kimi';
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;

  const child = spawnProcess(
    binary,
    ['session', 'list', '--cwd', options.cwd, '--json', '--limit', String(options.limit)],
    { env: mergeProcessEnv(process.env, {}), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code));
  });

  if (exitCode !== 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const summaries: SessionSummary[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as { id?: unknown; updatedAt?: unknown; createdAt?: unknown };
    if (typeof raw.id !== 'string' || !raw.id) continue;
    const mtime =
      typeof raw.updatedAt === 'number'
        ? raw.updatedAt
        : typeof raw.createdAt === 'number'
          ? raw.createdAt
          : Date.now();
    summaries.push({ sessionId: raw.id, mtime, preview: '(Kimi 会话)', lineCount: 0 });
  }
  return summaries;
}
