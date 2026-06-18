import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AntigravityConversationHistoryEntry {
  conversationId: string;
  preview: string;
  updatedAtMs: number;
  source: 'local-db' | 'local-proto';
}

export interface ListAntigravityConversationHistoryOptions {
  limit: number;
  dataDir?: string;
}

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(db|pb)$/i;

export async function listAntigravityConversationHistory(
  options: ListAntigravityConversationHistoryOptions,
): Promise<AntigravityConversationHistoryEntry[]> {
  const dir = join(options.dataDir ?? defaultAntigravityDataDir(), 'conversations');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const byId = new Map<string, AntigravityConversationHistoryEntry>();
  await Promise.all(
    names.map(async (name) => {
      const match = UUID_FILE_RE.exec(name);
      if (!match) return;
      const conversationId = match[1]!;
      const ext = match[2]!.toLowerCase();
      const path = join(dir, name);
      const st = await stat(path).catch(() => undefined);
      if (!st?.isFile()) return;
      const entry: AntigravityConversationHistoryEntry = {
        conversationId,
        preview: conversationId,
        updatedAtMs: st.mtimeMs,
        source: ext === 'db' ? 'local-db' : 'local-proto',
      };
      const existing = byId.get(conversationId);
      const shouldOverwrite =
        !existing ||
        (entry.source === 'local-db' && existing.source === 'local-proto') ||
        (entry.source === existing.source && entry.updatedAtMs > existing.updatedAtMs);
      if (shouldOverwrite) {
        byId.set(conversationId, entry);
      }
    }),
  );

  return [...byId.values()]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, options.limit);
}

export function defaultAntigravityDataDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}
