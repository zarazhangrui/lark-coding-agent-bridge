import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly sharedDir: string | undefined;

  constructor(path: string = paths.workspacesFile, sharedDir?: string) {
    this.path = path;
    this.sharedDir = sharedDir;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
      };
      for (const [scope, entry] of Object.entries(this.data.chats)) {
        this.scheduleSharedWrite(scope, entry.cwd);
      }
      await this.saving;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.readSharedCwd(chatId) ?? this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
    this.scheduleSharedWrite(chatId, cwd);
  }

  removeCwd(chatId: string): boolean {
    const hadLocal = chatId in this.data.chats;
    const hadShared = this.readSharedCwd(chatId) !== undefined;
    if (hadLocal) {
      delete this.data.chats[chatId];
      this.schedulePersist();
    }
    if (hadShared) this.scheduleSharedRemove(chatId);
    return hadLocal || hadShared;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return this.data.named[name];
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
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
        log.fail('workspace', err, { step: 'persist' });
      });
  }

  private sharedPath(scope: string): string | undefined {
    if (!this.sharedDir || !scope.includes(':')) return undefined;
    const key = createHash('sha256').update(scope).digest('hex');
    return join(this.sharedDir, `${key}.json`);
  }

  private readSharedCwd(scope: string): string | undefined {
    const path = this.sharedPath(scope);
    if (!path) return undefined;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { scope?: unknown; cwd?: unknown };
      return value.scope === scope && typeof value.cwd === 'string' ? value.cwd : undefined;
    } catch {
      return undefined;
    }
  }

  private scheduleSharedWrite(scope: string, cwd: string): void {
    const path = this.sharedPath(scope);
    if (!path) return;
    this.saving = this.saving
      .then(() =>
        writeFileAtomic(path, `${JSON.stringify({ scope, cwd }, null, 2)}\n`, { mode: 0o600 }),
      )
      .catch((err: unknown) => log.fail('workspace', err, { step: 'persist-shared' }));
  }

  private scheduleSharedRemove(scope: string): void {
    const path = this.sharedPath(scope);
    if (!path) return;
    this.saving = this.saving
      .then(() => rm(path, { force: true }))
      .catch((err: unknown) => log.fail('workspace', err, { step: 'remove-shared' }));
  }
}
