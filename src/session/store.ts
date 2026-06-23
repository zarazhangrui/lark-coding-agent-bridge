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
  /** One-shot handoff summary injected into the next fresh run after /compact. */
  pendingCompactSummary?: string;
  pendingCompactCwd?: string;
  pendingCompactUpdatedAt?: number;
}

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
        const pendingCompactSummary =
          typeof entry.pendingCompactSummary === 'string' && entry.pendingCompactSummary.trim()
            ? entry.pendingCompactSummary.trim()
            : undefined;
        const pendingCompactCwd =
          typeof entry.pendingCompactCwd === 'string' && entry.pendingCompactCwd.trim()
            ? entry.pendingCompactCwd.trim()
            : undefined;
        const pendingCompactUpdatedAt =
          typeof entry.pendingCompactUpdatedAt === 'number'
            ? entry.pendingCompactUpdatedAt
            : undefined;
        const hasSession = sessionId !== undefined && cwd !== undefined;
        const hasPendingCompact =
          pendingCompactSummary !== undefined && pendingCompactCwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined && !hasPendingCompact) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(hasPendingCompact
            ? {
                pendingCompactSummary,
                pendingCompactCwd,
                ...(pendingCompactUpdatedAt !== undefined
                  ? { pendingCompactUpdatedAt }
                  : {}),
              }
            : {}),
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
    this.pruneEmptyPreferenceOnlyEntry(chatId);
    this.schedulePersist();
    return true;
  }

  getPendingCompactSummary(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.pendingCompactCwd !== cwd) return undefined;
    return entry.pendingCompactSummary;
  }

  setPendingCompactSummary(chatId: string, cwd: string, summary: string): void {
    const value = compactSummary(summary);
    if (!value) {
      this.clearPendingCompactSummary(chatId);
      return;
    }
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      pendingCompactSummary: value,
      pendingCompactCwd: cwd,
      pendingCompactUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  consumePendingCompactSummary(chatId: string, cwd: string): string | undefined {
    const summary = this.getPendingCompactSummary(chatId, cwd);
    if (!summary) return undefined;
    this.clearPendingCompactSummary(chatId);
    return summary;
  }

  clearPendingCompactSummary(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.pendingCompactSummary === undefined) return false;
    const {
      pendingCompactSummary: _summary,
      pendingCompactCwd: _cwd,
      pendingCompactUpdatedAt: _updatedAt,
      ...rest
    } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.pruneEmptyPreferenceOnlyEntry(chatId);
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

  private pruneEmptyPreferenceOnlyEntry(chatId: string): void {
    const entry = this.data[chatId];
    if (!entry) return;
    if (
      entry.sessionId === undefined &&
      entry.cwd === undefined &&
      entry.idleTimeoutMinutes === undefined &&
      entry.pendingCompactSummary === undefined &&
      entry.pendingCompactCwd === undefined &&
      entry.pendingCompactUpdatedAt === undefined
    ) {
      delete this.data[chatId];
    }
  }
}

function compactSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= 30_000) return trimmed;
  return `${trimmed.slice(0, 30_000)}\n\n[summary truncated by bridge]`;
}
