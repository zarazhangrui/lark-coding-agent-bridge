import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConfigFileLock } from '../config/profile-store';
import { writeFileAtomic } from '../platform/atomic-write';

export type CodexTaskStatus =
  | 'pending'
  | 'reconcile'
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'timeout';

export interface CodexTaskRecord {
  handle: string;
  threadId?: string;
  title: string;
  cwd: string;
  model?: string;
  status: CodexTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastResult?: string;
  lastTurnId?: string;
  reconciliation?: CodexTaskReconciliation;
}

export interface CodexTaskReconciliation {
  desiredStatus: Exclude<CodexTaskStatus, 'pending' | 'reconcile'>;
  error: string;
  threadId?: string;
  lastTurnId?: string;
  lastResult?: string;
}

export interface ReserveCodexTaskInput {
  title: string;
  cwd: string;
  model?: string;
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
  lastTurnId?: string;
}

export interface MarkCodexTaskReconcileInput {
  desiredStatus: CodexTaskReconciliation['desiredStatus'];
  error: string;
  threadId?: string;
  lastTurnId?: string;
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

  async reserve(input: ReserveCodexTaskInput): Promise<CodexTaskRecord> {
    return withConfigFileLock(this.path, async () => {
      const tasks = await readRegistry(this.path);
      const timestamp = this.now().toISOString();
      const created = normalizeRecord({
        handle: allocateHandle(tasks, this.createHandle),
        title: input.title,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!created) throw new Error('failed to reserve a Codex task');
      tasks.push(created);
      await persistRegistry(this.path, tasks);
      return created;
    });
  }

  async importThread(handle: string, threadId: string): Promise<CodexTaskRecord> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error('thread id is required');
    return this.mutate(handle, (current) => ({
      ...current,
      threadId: normalizedThreadId,
      status: 'pending',
    }));
  }

  async markReconcile(handle: string, input: MarkCodexTaskReconcileInput): Promise<CodexTaskRecord> {
    return this.mutate(handle, (current) => ({
      ...current,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      status: 'reconcile',
      reconciliation: {
        desiredStatus: input.desiredStatus,
        error: input.error,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
      },
    }));
  }

  async reconcile(handle?: string): Promise<CodexTaskRecord[]> {
    const requested = handle ? normalizeHandle(handle) : undefined;
    return withConfigFileLock(this.path, async () => {
      const tasks = await readRegistry(this.path);
      let changed = false;
      const reconciled = tasks.map((task) => {
        if (task.status !== 'reconcile' || !task.reconciliation) return task;
        if (requested && task.handle !== requested) return task;
        const recovery = task.reconciliation;
        const updated = normalizeRecord({
          ...task,
          ...(recovery.threadId ? { threadId: recovery.threadId } : {}),
          status: recovery.desiredStatus,
          ...(recovery.lastTurnId ? { lastTurnId: recovery.lastTurnId } : {}),
          ...(recovery.lastResult !== undefined ? { lastResult: recovery.lastResult } : {}),
          reconciliation: undefined,
          updatedAt: this.now().toISOString(),
        });
        if (!updated) throw new Error(`failed to reconcile Codex task: ${task.handle}`);
        changed = true;
        return updated;
      });
      if (changed) await persistRegistry(this.path, reconciled);
      return reconciled
        .filter((task) => !requested || task.handle === requested)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
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

      const created = normalizeRecord({
        handle: allocateHandle(tasks, this.createHandle),
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
    return this.mutate(handle, (current) => ({
      ...current,
      ...(input.status ? { status: input.status } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
      ...(input.status === 'running'
        ? { lastTurnId: undefined }
        : input.lastTurnId
          ? { lastTurnId: input.lastTurnId }
          : {}),
      reconciliation: undefined,
    }));
  }

  private async mutate(
    handle: string,
    change: (current: CodexTaskRecord) => Record<string, unknown>,
  ): Promise<CodexTaskRecord> {
    const normalizedHandle = normalizeHandle(handle);
    return withConfigFileLock(this.path, async () => {
      const tasks = await readRegistry(this.path);
      const index = tasks.findIndex((task) => task.handle === normalizedHandle);
      if (index < 0) throw new Error(`Codex task not found: ${normalizedHandle}`);
      const updated = normalizeRecord({
        ...change(tasks[index]!),
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

function allocateHandle(tasks: CodexTaskRecord[], createHandle: () => string): string {
  const handles = new Set(tasks.map((task) => task.handle));
  let handle = createHandle();
  for (let attempt = 0; handles.has(handle); attempt++) {
    if (attempt >= 99) throw new Error('failed to allocate a unique Codex task handle');
    handle = createHandle();
  }
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
  const reconciliation = normalizeReconciliation(raw.reconciliation);
  if (
    !HANDLE_PATTERN.test(handle) ||
    (raw.threadId !== undefined && (typeof raw.threadId !== 'string' || !raw.threadId)) ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    typeof raw.cwd !== 'string' ||
    !raw.cwd ||
    !isStatus(status) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    (status === 'reconcile' && !reconciliation)
  ) {
    return undefined;
  }
  return {
    handle,
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
    title: raw.title.trim(),
    cwd: raw.cwd,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(typeof raw.lastResult === 'string' ? { lastResult: raw.lastResult } : {}),
    ...(typeof raw.lastTurnId === 'string' && raw.lastTurnId ? { lastTurnId: raw.lastTurnId } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

function normalizeReconciliation(value: unknown): CodexTaskReconciliation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isSettledStatus(raw.desiredStatus) || typeof raw.error !== 'string' || !raw.error) return undefined;
  return {
    desiredStatus: raw.desiredStatus,
    error: raw.error,
    ...(typeof raw.threadId === 'string' && raw.threadId ? { threadId: raw.threadId } : {}),
    ...(typeof raw.lastTurnId === 'string' && raw.lastTurnId ? { lastTurnId: raw.lastTurnId } : {}),
    ...(typeof raw.lastResult === 'string' ? { lastResult: raw.lastResult } : {}),
  };
}

function isStatus(value: unknown): value is CodexTaskStatus {
  return value === 'pending'
    || value === 'reconcile'
    || value === 'idle'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted'
    || value === 'timeout';
}

function isSettledStatus(value: unknown): value is CodexTaskReconciliation['desiredStatus'] {
  return value === 'idle'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted'
    || value === 'timeout';
}
