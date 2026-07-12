import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export type DesktopStatus =
  | 'offline'
  | 'connecting'
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'tool_running'
  | 'streaming'
  | 'reconnecting'
  | 'error';

export type DesktopStatusErrorKind =
  | 'connection'
  | 'agent'
  | 'timeout'
  | 'interrupted'
  | 'unknown';

export interface DesktopProfileStatusSnapshot {
  profile: string;
  botName?: string;
  appIdSuffix?: string;
  agent: string;
  status: DesktopStatus;
  activeRunCount: number;
  queuedMessageCount: number;
  updatedAt: string;
  lastErrorKind?: DesktopStatusErrorKind;
}

export interface DesktopStatusSnapshot {
  updatedAt: string;
  aggregateStatus: DesktopStatus;
  profiles: DesktopProfileStatusSnapshot[];
}

export interface DesktopStatusPaths {
  statusFile: string;
  lockFile: string;
  positionFile: string;
}

export interface DesktopStatusReporterInput {
  rootDir: string;
  profile: string;
  agent: string;
  appId: string;
  botName?: string;
  now?: () => Date;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface UpdateProfileStatusInput {
  status?: DesktopStatus;
  botName?: string;
  activeRunCount?: number;
  queuedMessageCount?: number;
  lastErrorKind?: DesktopStatusErrorKind;
}

export interface FloatingBallPosition {
  x: number;
  y: number;
}

export interface VisibleFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DESKTOP_STATUS_PRIORITY: Record<DesktopStatus, number> = {
  offline: 0,
  connecting: 1,
  idle: 2,
  queued: 3,
  thinking: 4,
  streaming: 5,
  tool_running: 6,
  reconnecting: 7,
  error: 8,
};

const DEFAULT_BALL_SIZE = 44;
const DEFAULT_SAFE_INSET = 12;

export function desktopStatusPaths(rootDir: string): DesktopStatusPaths {
  return {
    statusFile: join(rootDir, 'desktop-status.json'),
    lockFile: join(rootDir, 'registry', 'desktop-status.lock'),
    positionFile: join(rootDir, 'desktop-floating-ball.json'),
  };
}

export function aggregateDesktopStatus(
  profiles: readonly Pick<DesktopProfileStatusSnapshot, 'status'>[],
): DesktopStatus {
  let selected: DesktopStatus = 'offline';
  for (const profile of profiles) {
    if (DESKTOP_STATUS_PRIORITY[profile.status] > DESKTOP_STATUS_PRIORITY[selected]) {
      selected = profile.status;
    }
  }
  return selected;
}

export function sanitizeProfileStatus(input: {
  profile: string;
  botName?: string;
  appId?: string;
  appIdSuffix?: string;
  agent: string;
  status: DesktopStatus;
  activeRunCount?: number;
  queuedMessageCount?: number;
  updatedAt?: string;
  lastErrorKind?: DesktopStatusErrorKind;
}): DesktopProfileStatusSnapshot {
  return {
    profile: input.profile,
    ...(input.botName ? { botName: input.botName } : {}),
    ...(input.appIdSuffix ?? input.appId
      ? { appIdSuffix: (input.appIdSuffix ?? input.appId ?? '').slice(-6) }
      : {}),
    agent: input.agent,
    status: input.status,
    activeRunCount: nonNegativeInteger(input.activeRunCount),
    queuedMessageCount: nonNegativeInteger(input.queuedMessageCount),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.lastErrorKind ? { lastErrorKind: input.lastErrorKind } : {}),
  };
}

export async function readDesktopStatusSnapshot(
  rootDir: string,
): Promise<DesktopStatusSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(desktopStatusPaths(rootDir).statusFile, 'utf8')) as unknown;
    return normalizeSnapshot(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function writeDesktopStatusSnapshot(
  rootDir: string,
  snapshot: DesktopStatusSnapshot,
): Promise<void> {
  await writeFileAtomic(desktopStatusPaths(rootDir).statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function updateDesktopProfileStatus(
  rootDir: string,
  profileStatus: DesktopProfileStatusSnapshot,
): Promise<DesktopStatusSnapshot> {
  return withDesktopStatusLock(rootDir, async () => {
    const current = await readDesktopStatusSnapshot(rootDir);
    const profiles = [
      ...(current?.profiles ?? []).filter((item) => item.profile !== profileStatus.profile),
      profileStatus,
    ].sort((a, b) => a.profile.localeCompare(b.profile));
    const snapshot: DesktopStatusSnapshot = {
      updatedAt: profileStatus.updatedAt,
      aggregateStatus: aggregateDesktopStatus(profiles),
      profiles,
    };
    await writeDesktopStatusSnapshot(rootDir, snapshot);
    return snapshot;
  });
}

export async function removeDesktopProfileStatus(
  rootDir: string,
  profile: string,
  now: Date = new Date(),
): Promise<DesktopStatusSnapshot> {
  return withDesktopStatusLock(rootDir, async () => {
    const current = await readDesktopStatusSnapshot(rootDir);
    const profiles = (current?.profiles ?? []).filter((item) => item.profile !== profile);
    const snapshot: DesktopStatusSnapshot = {
      updatedAt: now.toISOString(),
      aggregateStatus: aggregateDesktopStatus(profiles),
      profiles,
    };
    await writeDesktopStatusSnapshot(rootDir, snapshot);
    return snapshot;
  });
}

export class DesktopStatusReporter {
  private readonly rootDir: string;
  private readonly profile: string;
  private readonly agent: string;
  private readonly appId: string;
  private readonly now: () => Date;
  private readonly onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  private snapshot: DesktopProfileStatusSnapshot;
  private errorRecoveryTimer: NodeJS.Timeout | undefined;

  constructor(input: DesktopStatusReporterInput) {
    this.rootDir = input.rootDir;
    this.profile = input.profile;
    this.agent = input.agent;
    this.appId = input.appId;
    this.now = input.now ?? (() => new Date());
    this.onWarning = input.onWarning;
    this.snapshot = sanitizeProfileStatus({
      profile: input.profile,
      botName: input.botName,
      appId: input.appId,
      agent: input.agent,
      status: 'offline',
      updatedAt: this.now().toISOString(),
    });
  }

  current(): DesktopProfileStatusSnapshot {
    return { ...this.snapshot };
  }

  async update(input: UpdateProfileStatusInput): Promise<void> {
    if (input.status !== 'error' && this.errorRecoveryTimer) {
      clearTimeout(this.errorRecoveryTimer);
      this.errorRecoveryTimer = undefined;
    }
    this.snapshot = sanitizeProfileStatus({
      ...this.snapshot,
      ...input,
      profile: this.profile,
      appId: this.appId,
      agent: this.agent,
      status: input.status ?? this.snapshot.status,
      updatedAt: this.now().toISOString(),
      lastErrorKind: input.status === 'error'
        ? input.lastErrorKind ?? this.snapshot.lastErrorKind ?? 'unknown'
        : input.lastErrorKind,
    });
    await this.safeWrite();
  }

  async errorThenIdle(kind: DesktopStatusErrorKind, delayMs = 5000): Promise<void> {
    await this.update({ status: 'error', lastErrorKind: kind, activeRunCount: 0 });
    if (this.errorRecoveryTimer) clearTimeout(this.errorRecoveryTimer);
    this.errorRecoveryTimer = setTimeout(() => {
      this.errorRecoveryTimer = undefined;
      void this.update({ status: 'idle', lastErrorKind: undefined }).catch((err) =>
        this.warn('desktop status recovery write failed', { err: String(err) }),
      );
    }, delayMs);
  }

  async clear(): Promise<void> {
    if (this.errorRecoveryTimer) clearTimeout(this.errorRecoveryTimer);
    this.errorRecoveryTimer = undefined;
    await removeDesktopProfileStatus(this.rootDir, this.profile, this.now()).catch((err) =>
      this.warn('desktop status clear failed', { err: String(err) }),
    );
  }

  private async safeWrite(): Promise<void> {
    await updateDesktopProfileStatus(this.rootDir, this.snapshot).catch((err) =>
      this.warn('desktop status write failed', { err: String(err) }),
    );
  }

  private warn(message: string, fields?: Record<string, unknown>): void {
    this.onWarning?.(message, fields);
  }
}

export async function readFloatingBallPosition(
  rootDir: string,
): Promise<FloatingBallPosition | undefined> {
  try {
    const parsed = JSON.parse(await readFile(desktopStatusPaths(rootDir).positionFile, 'utf8')) as unknown;
    return isPosition(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function writeFloatingBallPosition(
  rootDir: string,
  position: FloatingBallPosition,
): Promise<void> {
  const safe = clampFloatingBallPosition(position, {
    x: Number.MIN_SAFE_INTEGER / 4,
    y: Number.MIN_SAFE_INTEGER / 4,
    width: Number.MAX_SAFE_INTEGER / 2,
    height: Number.MAX_SAFE_INTEGER / 2,
  });
  await writeFileAtomic(desktopStatusPaths(rootDir).positionFile, `${JSON.stringify(safe, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function clampFloatingBallPosition(
  position: FloatingBallPosition | undefined,
  frame: VisibleFrame,
  ballSize = DEFAULT_BALL_SIZE,
  inset = DEFAULT_SAFE_INSET,
): FloatingBallPosition {
  const minX = frame.x + inset;
  const minY = frame.y + inset;
  const maxX = frame.x + Math.max(inset, frame.width - ballSize - inset);
  const maxY = frame.y + Math.max(inset, frame.height - ballSize - inset);
  const fallback = {
    x: maxX,
    y: minY,
  };
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return fallback;
  }
  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY),
  };
}

async function withDesktopStatusLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const { lockFile } = desktopStatusPaths(rootDir);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, '', { flag: 'a', mode: 0o600 });
  await chmod(lockFile, 0o600).catch(() => {});
  const release = await lockfile.lock(lockFile, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function normalizeSnapshot(value: unknown): DesktopStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<DesktopStatusSnapshot>;
  if (!Array.isArray(raw.profiles)) return undefined;
  const profiles = raw.profiles
    .map((item) => normalizeProfileSnapshot(item))
    .filter((item): item is DesktopProfileStatusSnapshot => Boolean(item));
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString();
  return {
    updatedAt,
    aggregateStatus: aggregateDesktopStatus(profiles),
    profiles,
  };
}

function normalizeProfileSnapshot(value: unknown): DesktopProfileStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<DesktopProfileStatusSnapshot>;
  if (
    typeof raw.profile !== 'string' ||
    typeof raw.agent !== 'string' ||
    !isDesktopStatus(raw.status) ||
    typeof raw.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return sanitizeProfileStatus({
    profile: raw.profile,
    botName: typeof raw.botName === 'string' ? raw.botName : undefined,
    appIdSuffix: typeof raw.appIdSuffix === 'string' ? raw.appIdSuffix : undefined,
    agent: raw.agent,
    status: raw.status,
    activeRunCount: raw.activeRunCount,
    queuedMessageCount: raw.queuedMessageCount,
    updatedAt: raw.updatedAt,
    lastErrorKind: isErrorKind(raw.lastErrorKind) ? raw.lastErrorKind : undefined,
  });
}

function isDesktopStatus(value: unknown): value is DesktopStatus {
  return (
    value === 'offline' ||
    value === 'connecting' ||
    value === 'idle' ||
    value === 'queued' ||
    value === 'thinking' ||
    value === 'tool_running' ||
    value === 'streaming' ||
    value === 'reconnecting' ||
    value === 'error'
  );
}

function isErrorKind(value: unknown): value is DesktopStatusErrorKind {
  return (
    value === 'connection' ||
    value === 'agent' ||
    value === 'timeout' ||
    value === 'interrupted' ||
    value === 'unknown'
  );
}

function isPosition(value: unknown): value is FloatingBallPosition {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<FloatingBallPosition>;
  return typeof raw.x === 'number' && Number.isFinite(raw.x) &&
    typeof raw.y === 'number' && Number.isFinite(raw.y);
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}
