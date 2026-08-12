import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. Session resets preserve this
   * scope preference while removing the resumable session id/cwd. */
  idleTimeoutMinutes?: number;
  /**
   * Lightweight cursor for topic-context replay. The bridge persists the
   * upstream message id/create time plus a bounded set of ids seen around the
   * boundary — never message bodies — so a resumed topic can ask Feishu for
   * just the messages that arrived since the last successful run. This is
   * intentionally independent of sessionId/cwd: Codex threads live in
   * SessionCatalog, but still share the same topic context cursor.
   */
  topicCursor?: TopicCursor;
}

export interface TopicCursor {
  messageId: string;
  createTime: number;
  /**
   * Bounded ids observed while reading the topic around this cursor.  The
   * bridge uses these ids to de-duplicate a small overlap window on the next
   * read, which protects against Feishu's eventually-consistent message list
   * briefly omitting a message between two visible rows.  Bodies are never
   * persisted here.
   */
  recentMessageIds?: string[];
}

/** Keep the persisted replay metadata small and independent of topic length. */
export const MAX_TOPIC_CURSOR_RECENT_IDS = 128;

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override). Resuming a session whose cwd we don't know about
        // would hang claude on a missing jsonl, so resume keys still need
        // the full pair; but a bare timeout override is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const topicCursor = normalizeTopicCursor(entry.topicCursor);
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined && topicCursor === undefined) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(topicCursor ? { topicCursor } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(prev?.topicCursor ? { topicCursor: prev.topicCursor } : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.idleTimeoutMinutes !== undefined) {
      this.data[chatId] = {
        idleTimeoutMinutes: prev.idleTimeoutMinutes,
        updatedAt: Date.now(),
      };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }

  /** Return the last successfully-triggered topic message for this scope. */
  getTopicCursor(scope: string): TopicCursor | undefined {
    const cursor = this.data[scope]?.topicCursor;
    return cursor
      ? {
          ...cursor,
          ...(cursor.recentMessageIds
            ? { recentMessageIds: [...cursor.recentMessageIds] }
            : {}),
        }
      : undefined;
  }

  /**
   * Persist the topic cursor after an agent run has successfully started.
   * Keeping this state on SessionStore (rather than alongside a particular
   * agent session) lets both Claude and Codex share the same replay boundary.
   */
  setTopicCursor(scope: string, cursor: TopicCursor): void {
    const normalized = normalizeTopicCursor(cursor);
    if (!normalized) return;
    const prev = this.data[scope];
    this.data[scope] = {
      ...(prev ?? { updatedAt: Date.now() }),
      topicCursor: normalized,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}

function normalizeTopicCursor(input: unknown): TopicCursor | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as { messageId?: unknown; createTime?: unknown };
  const createTime =
    typeof raw.createTime === 'number'
      ? raw.createTime
      : typeof raw.createTime === 'string' && raw.createTime.trim() !== ''
        ? Number(raw.createTime)
        : Number.NaN;
  if (
    typeof raw.messageId !== 'string' ||
    raw.messageId.length === 0 ||
    !Number.isFinite(createTime) ||
    createTime < 0
  ) {
    return undefined;
  }
  const recentMessageIds = normalizeRecentMessageIds(
    (input as { recentMessageIds?: unknown }).recentMessageIds,
  );
  return {
    messageId: raw.messageId,
    createTime,
    ...(recentMessageIds.length > 0 ? { recentMessageIds } : {}),
  };
}

function normalizeRecentMessageIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_TOPIC_CURSOR_RECENT_IDS) break;
  }
  return out;
}
