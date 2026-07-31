import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConfigFileLock } from '../config/profile-store';
import { writeFileAtomic } from '../platform/atomic-write';

export type CodexTaskStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'timeout';

export interface CodexTaskRecord {
  handle: string;
  threadId: string;
  title: string;
  cwd: string;
  model?: string;
  status: CodexTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastResult?: string;
}

export interface RegisterCodexTaskInput {
  threadId: string;
  title: string;
  cwd: string;
  model?: string;
  status?: CodexTaskStatus;
  lastResult?: string;
}

export interface UpdateCodexTaskInput {
  status?: CodexTaskStatus;
  model?: string;
  lastResult?: string;
}

const HANDLE_PATTERN = /^T-[A-F0-9]{6}$/;
const REGISTRY_SCHEMA_VERSION = 1;

export class CodexTaskRegistry {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createHandle: () => string = randomHandle,
  ) {}

  async list(): Promise<CodexTaskRecord[]> {
    const tasks = await readRegistry(this.path);
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(handle: string): Promise<CodexTaskRecord | undefined> {
    const normalized = normalizeHandle(handle);
    return (await readRegistry(this.path)).find((task) => task.handle === normalized);
  }

  async register(input: RegisterCodexTaskInput): Promise<CodexTaskRecord> {
    return withConfigFileLock(this.path, async () => {
      const tasks = await readRegistry(this.path);
      const existing = tasks.find((task) => task.threadId === input.threadId);
      const timestamp = this.now().toISOString();
      if (existing) {
        const updated = normalizeRecord({
          ...existing,
          title: input.title,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          status: input.status ?? existing.status,
          updatedAt: timestamp,
          ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
        });
        if (!updated) throw new Error('failed to normalize existing Codex task');
        await persistRegistry(this.path, tasks.map((task) => task.handle === existing.handle ? updated : task));
        return updated;
      }

      const handles = new Set(tasks.map((task) => task.handle));
      let handle = this.createHandle();
      for (let attempt = 0; handles.has(handle); attempt++) {
        if (attempt >= 99) throw new Error('failed to allocate a unique Codex task handle');
        handle = this.createHandle();
      }
      const created = normalizeRecord({
        handle,
        threadId: input.threadId,
        title: input.title,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        status: input.status ?? 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
      });
      if (!created) throw new Error('failed to normalize new Codex task');
      tasks.push(created);
      await persistRegistry(this.path, tasks);
      return created;
    });
  }

  async update(handle: string, input: UpdateCodexTaskInput): Promise<CodexTaskRecord> {
    const normalizedHandle = normalizeHandle(handle);
    return withConfigFileLock(this.path, async () => {
      const tasks = await readRegistry(this.path);
      const index = tasks.findIndex((task) => task.handle === normalizedHandle);
      if (index < 0) throw new Error(`Codex task not found: ${normalizedHandle}`);
      const current = tasks[index]!;
      const updated = normalizeRecord({
        ...current,
        ...(input.status ? { status: input.status } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
        updatedAt: this.now().toISOString(),
      });
      if (!updated) throw new Error(`failed to normalize Codex task: ${normalizedHandle}`);
      tasks[index] = updated;
      await persistRegistry(this.path, tasks);
      return updated;
    });
  }
}

function randomHandle(): string {
  return `T-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function normalizeHandle(value: string): string {
  const handle = value.trim().toUpperCase();
  if (!HANDLE_PATTERN.test(handle)) throw new Error(`invalid Codex task handle: ${value}`);
  return handle;
}

async function readRegistry(path: string): Promise<CodexTaskRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`invalid Codex task registry: ${path}`);
    }
    const raw = parsed as Record<string, unknown>;
    if (raw.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(raw.tasks)) {
      throw new Error(`unsupported or damaged Codex task registry: ${path}`);
    }
    const tasks = raw.tasks.map(normalizeRecord);
    if (tasks.some((task) => !task)) {
      throw new Error(`damaged Codex task registry entry: ${path}`);
    }
    return tasks as CodexTaskRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function persistRegistry(path: string, tasks: CodexTaskRecord[]): Promise<void> {
  const sorted = [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  await writeFileAtomic(path, `${JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    tasks: sorted,
  }, null, 2)}\n`, { mode: 0o600 });
}

function normalizeRecord(value: unknown): CodexTaskRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const handle = typeof raw.handle === 'string' ? raw.handle.toUpperCase() : '';
  const status = raw.status;
  if (
    !HANDLE_PATTERN.test(handle) ||
    typeof raw.threadId !== 'string' ||
    !raw.threadId ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    typeof raw.cwd !== 'string' ||
    !raw.cwd ||
    !isStatus(status) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    handle,
    threadId: raw.threadId,
    title: raw.title.trim(),
    cwd: raw.cwd,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(typeof raw.lastResult === 'string' ? { lastResult: raw.lastResult } : {}),
  };
}

function isStatus(value: unknown): value is CodexTaskStatus {
  return value === 'idle'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted'
    || value === 'timeout';
}
