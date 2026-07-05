import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TopicContextEntry {
  id: string;
  role: 'user' | 'assistant';
  speaker: string;
  agent?: string;
  text: string;
  ts?: string;
}

const MAX_ENTRY_CHARS = 8_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_LIMIT = 24;

export class TopicContextStore {
  constructor(private readonly dir: string) {}

  async append(scope: string, entry: TopicContextEntry): Promise<void> {
    const path = this.pathFor(scope);
    if (!path) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const value = {
      ...entry,
      text: entry.text.slice(0, MAX_ENTRY_CHARS),
      ts: entry.ts ?? new Date().toISOString(),
    };
    await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async read(
    scope: string,
    options: { excludeIds?: readonly string[]; limit?: number; maxChars?: number } = {},
  ): Promise<TopicContextEntry[]> {
    const path = this.pathFor(scope);
    if (!path) return [];
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const excluded = new Set(options.excludeIds ?? []);
    const deduped = new Map<string, TopicContextEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Partial<TopicContextEntry>;
        if (
          typeof entry.id !== 'string' ||
          excluded.has(entry.id) ||
          (entry.role !== 'user' && entry.role !== 'assistant') ||
          typeof entry.speaker !== 'string' ||
          typeof entry.text !== 'string'
        ) {
          continue;
        }
        deduped.set(`${entry.role}:${entry.id}`, entry as TopicContextEntry);
      } catch {
        // A partial final line can occur if a process is killed during append.
      }
    }

    const limit = options.limit ?? DEFAULT_LIMIT;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const recent = [...deduped.values()].slice(-limit);
    const selected: TopicContextEntry[] = [];
    let chars = 0;
    for (let index = recent.length - 1; index >= 0; index--) {
      const entry = recent[index];
      if (!entry) continue;
      if (selected.length > 0 && chars + entry.text.length > maxChars) break;
      selected.unshift(entry);
      chars += entry.text.length;
    }
    return selected;
  }

  private pathFor(scope: string): string | undefined {
    if (!scope.includes(':')) return undefined;
    const key = createHash('sha256').update(scope).digest('hex');
    return join(this.dir, `${key}.jsonl`);
  }
}
