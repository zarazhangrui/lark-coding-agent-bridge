import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * A single outbound-message → source-session mapping.
 *
 * The bridge records one of these every time it sends a reply, keyed by the
 * reply's `message_id`. When a later inbound message reply-quotes that
 * `message_id`, the bridge routes the new run back to `scope` (and, through
 * the scope, the same session + cwd) instead of the quoting chat's own scope.
 * This lets a user pull a past answer's conversation into any chat by quoting
 * it.
 *
 * `sessionId` / `cwd` are informational: the bridge routes by `scope` (session
 * and cwd follow the scope's current state), but they're persisted so external
 * tools can target a session directly — see {@link MessageRouteStore}.
 */
export interface MessageRoute {
  scope: string;
  sessionId?: string;
  cwd?: string;
  /** Epoch ms the entry was recorded; used for LRU-style pruning. */
  ts: number;
}

type RouteMap = Record<string, MessageRoute>;

/**
 * Keep the ledger bounded — a busy bot would otherwise grow it without limit.
 * Oldest entries (by `ts`) are evicted first. 1000 recent outbound messages is
 * far more reply-quote reach-back than anyone uses in practice.
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * On-disk ledger mapping an outbound `message_id` to the session scope it was
 * produced by. Lives next to `sessions.json` (default
 * `<sessionsFile>.routes.json`, mirroring the `.catalog.json` convention).
 *
 * Disk is the source of truth: every {@link lookup} and {@link record} reads
 * the current file, so the bridge is **not** the only permitted writer.
 * External notification tools (anything that sends messages "as" this bot via
 * its own path) can append their own `message_id → {scope, sessionId, cwd, ts}`
 * entries to the same JSON object to make those messages reply-quote-routable
 * too. This is the intended, documented extension point.
 *
 * All operations are best-effort: a missing or corrupt file resolves to "no
 * route" rather than throwing, so a broken ledger degrades to the normal
 * per-chat routing instead of breaking message handling.
 */
export class MessageRouteStore {
  private readonly path: string;
  private readonly maxEntries: number;
  /** Serializes this process's own writes so concurrent records don't lose
   * each other's entries. Cross-process writers race last-writer-wins, which
   * is acceptable for a best-effort routing hint. */
  private writes: Promise<void> = Promise.resolve();

  constructor(path: string = `${paths.sessionsFile}.routes.json`, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.path = path;
    this.maxEntries = maxEntries;
  }

  /**
   * Return the route recorded for `messageId`, or `undefined` when there is
   * none / the ledger can't be read. Never throws.
   */
  async lookup(messageId: string): Promise<MessageRoute | undefined> {
    const map = await this.read();
    const entry = map[messageId];
    if (!entry || typeof entry.scope !== 'string' || entry.scope.length === 0) return undefined;
    return entry;
  }

  /**
   * Upsert `messageId → route` and persist. Serialized against this process's
   * other records and performed as a read-modify-write so entries added by
   * external writers between reads are preserved. Never throws — logs and
   * moves on, since a failed routing hint must not fail message sending.
   */
  async record(messageId: string, route: MessageRoute): Promise<void> {
    this.writes = this.writes
      .then(async () => {
        const map = await this.read();
        map[messageId] = route;
        this.prune(map);
        await writeFileAtomic(this.path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
      })
      .catch((err: unknown) => {
        log.warn('quote-route', 'record-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    return this.writes;
  }

  /** Wait for pending writes to settle (tests / shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }

  private async read(): Promise<RouteMap> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<MessageRoute>>;
      const out: RouteMap = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.scope !== 'string' || typeof entry.ts !== 'number') continue;
        out[id] = {
          scope: entry.scope,
          ts: entry.ts,
          ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
        };
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      log.warn('quote-route', 'read-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  private prune(map: RouteMap): void {
    const ids = Object.keys(map);
    if (ids.length <= this.maxEntries) return;
    ids
      .sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0))
      .slice(0, ids.length - this.maxEntries)
      .forEach((id) => delete map[id]);
  }
}
