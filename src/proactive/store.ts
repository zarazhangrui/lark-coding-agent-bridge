import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type {
  FollowUp,
  ObserverMessage,
  ProactiveDecision,
  ProactiveState,
  ProactiveUserPreferences,
  ProactiveTask,
} from './types';

const EMPTY_STATE: ProactiveState = {
  version: 3,
  messages: [],
  decisions: [],
  followUps: [],
  preferences: [],
  tasks: [],
  processedMessageIds: [],
};

const MAX_MESSAGES = 2_000;
const MAX_DECISIONS = 2_000;
const MAX_PROCESSED = 5_000;

export class ProactiveStore {
  private state: ProactiveState = structuredClone(EMPTY_STATE);
  private saving: Promise<void> = Promise.resolve();
  private saveError: unknown;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ProactiveState>;
      this.state = {
        version: 3,
        messages: Array.isArray(raw.messages) ? raw.messages.filter(validMessage) : [],
        decisions: Array.isArray(raw.decisions) ? raw.decisions.filter(validDecision) : [],
        followUps: Array.isArray(raw.followUps)
          ? raw.followUps.filter(validFollowUp).map(migrateFollowUp)
          : [],
        preferences: Array.isArray(raw.preferences)
          ? raw.preferences.filter(validPreferences)
          : [],
        tasks: Array.isArray(raw.tasks) ? raw.tasks.filter(validTask) : [],
        processedMessageIds: Array.isArray(raw.processedMessageIds)
          ? raw.processedMessageIds.filter((id): id is string => typeof id === 'string')
          : [],
      };
      if (raw.version !== 3 || !Array.isArray(raw.tasks)) {
        this.persist();
        await this.flush();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  hasProcessed(messageId: string): boolean {
    return this.state.processedMessageIds.includes(messageId);
  }

  latestMessageTime(): number | undefined {
    return this.state.messages.reduce<number | undefined>(
      (latest, item) => (latest === undefined || item.createTime > latest ? item.createTime : latest),
      undefined,
    );
  }

  recordMessage(message: ObserverMessage): void {
    this.state.messages.push(message);
    this.state.processedMessageIds.push(message.messageId);
    this.trim();
    this.persist();
  }

  recordDecision(decision: ProactiveDecision): void {
    this.state.decisions.push(decision);
    this.trim();
    this.persist();
  }

  recentMessages(
    chatId: string,
    since: number,
    limit: number,
    threadId?: string,
  ): ObserverMessage[] {
    return this.state.messages
      .filter(
        (item) =>
          item.chatId === chatId && item.threadId === threadId && item.createTime >= since,
      )
      .slice(-limit);
  }

  pendingFollowUps(chatId: string, threadId?: string): FollowUp[] {
    return this.state.followUps.filter(
      (item) =>
        item.chatId === chatId && item.threadId === threadId && item.status === 'pending',
    );
  }

  openFollowUps(chatId: string, threadId?: string): FollowUp[] {
    return this.state.followUps.filter(
      (item) =>
        item.chatId === chatId &&
        item.threadId === threadId &&
        (item.status === 'proposed' || item.status === 'pending'),
    );
  }

  userFollowUps(userId: string): FollowUp[] {
    return this.state.followUps.filter((item) => item.ownerId === userId);
  }

  dueFollowUps(now: number): FollowUp[] {
    return this.state.followUps.filter(
      (item) =>
        item.status === 'pending' &&
        item.dueAt !== undefined &&
        (item.nextReminderAt ?? item.dueAt) <= now &&
        item.reminderAttemptedAt === undefined,
    );
  }

  getFollowUp(id: string): FollowUp | undefined {
    return this.state.followUps.find((item) => item.id === id);
  }

  createFollowUp(followUp: FollowUp): boolean {
    if (
      this.state.followUps.some(
        (item) =>
          item.chatId === followUp.chatId &&
          item.sourceMessageId === followUp.sourceMessageId,
      )
    ) {
      return false;
    }
    this.state.followUps.push(followUp);
    this.persist();
    return true;
  }

  updateFollowUp(id: string, update: Partial<FollowUp>): FollowUp | undefined {
    const item = this.getFollowUp(id);
    if (!item) return undefined;
    Object.assign(item, update);
    this.persist();
    return item;
  }

  preferencesFor(userId: string, defaultDailyReminderLimit = 5): ProactiveUserPreferences {
    return (
      this.state.preferences.find((item) => item.userId === userId) ?? {
        userId,
        enabled: true,
        overdueReminders: true,
        dailyReminderLimit: defaultDailyReminderLimit,
        updatedAt: 0,
      }
    );
  }

  updatePreferences(
    userId: string,
    update: Partial<Omit<ProactiveUserPreferences, 'userId'>>,
    defaultDailyReminderLimit = 5,
  ): ProactiveUserPreferences {
    let item = this.state.preferences.find((candidate) => candidate.userId === userId);
    if (!item) {
      item = this.preferencesFor(userId, defaultDailyReminderLimit);
      this.state.preferences.push(item);
    }
    Object.assign(item, update);
    this.persist();
    return item;
  }

  remindersSentBy(userId: string, from: number, to: number): number {
    return this.state.followUps.reduce(
      (count, item) =>
        item.ownerId === userId
          ? count + (item.reminderHistory ?? []).filter((sentAt) => sentAt >= from && sentAt < to).length
          : count,
      0,
    );
  }

  snapshot(): ProactiveState {
    return structuredClone(this.state);
  }

  getTask(id: string): ProactiveTask | undefined {
    return this.state.tasks.find((task) => task.id === id);
  }

  tasksFor(chatId: string, ownerId: string, threadId?: string): ProactiveTask[] {
    return this.state.tasks.filter((task) =>
      task.chatId === chatId && task.ownerId === ownerId && task.threadId === threadId);
  }

  createTask(task: ProactiveTask): boolean {
    if (this.getTask(task.id)) return false;
    this.state.tasks.push(task);
    this.persist();
    return true;
  }

  updateTask(id: string, update: Partial<ProactiveTask>): ProactiveTask | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;
    Object.assign(task, update);
    this.persist();
    return task;
  }

  async flush(): Promise<void> {
    await this.saving;
    if (this.saveError) throw this.saveError;
  }

  private trim(): void {
    this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
    this.state.decisions = this.state.decisions.slice(-MAX_DECISIONS);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-MAX_PROCESSED);
  }

  private persist(): void {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saving = this.saving.then(async () => {
      try {
        await writeFileAtomic(this.path, serialized, { mode: 0o600 });
        this.saveError = undefined;
      } catch (err) {
        this.saveError = err;
        log.fail('proactive', err, { step: 'persist' });
      }
    });
  }
}

function validTask(value: unknown): value is ProactiveTask {
  const task = value as Partial<ProactiveTask> | undefined;
  return Boolean(task && typeof task.id === 'string' && typeof task.chatId === 'string' &&
    typeof task.sourceMessageId === 'string' && typeof task.ownerId === 'string' &&
    typeof task.request === 'string' && typeof task.fingerprint === 'string' &&
    ['summary', 'research', 'draft'].includes(task.kind ?? '') &&
    ['proposed', 'needs_input', 'running', 'publishing', 'delivered', 'accepted', 'failed', 'cancelled'].includes(task.status ?? '') &&
    Number.isInteger(task.revision) && Number.isFinite(task.createdAt) &&
    Number.isFinite(task.updatedAt) && Array.isArray(task.artifacts) &&
    Array.isArray(task.context) && task.context.every(validMessage));
}

function validMessage(value: unknown): value is ObserverMessage {
  const item = value as Partial<ObserverMessage> | undefined;
  return Boolean(
    item &&
      typeof item.messageId === 'string' &&
      typeof item.chatId === 'string' &&
      (item.threadId === undefined || typeof item.threadId === 'string') &&
      typeof item.senderId === 'string' &&
      (item.mentions === undefined ||
        (Array.isArray(item.mentions) &&
          item.mentions.every((mention) =>
            Boolean(mention && typeof mention.id === 'string'),
          ))) &&
      typeof item.text === 'string' &&
      typeof item.createTime === 'number',
  );
}

function validDecision(value: unknown): value is ProactiveDecision {
  const item = value as Partial<ProactiveDecision> | undefined;
  return Boolean(item && typeof item.messageId === 'string' && typeof item.decidedAt === 'number');
}

function validFollowUp(value: unknown): value is FollowUp {
  const item = value as Partial<FollowUp> | undefined;
  return Boolean(
    item &&
      typeof item.id === 'string' &&
      typeof item.chatId === 'string' &&
      (item.threadId === undefined || typeof item.threadId === 'string') &&
      typeof item.sourceMessageId === 'string' &&
      typeof item.summary === 'string' &&
      (item.dueAt === undefined || typeof item.dueAt === 'number') &&
      (item.status === 'proposed' ||
        item.status === 'pending' ||
        item.status === 'completed' ||
        item.status === 'cancelled') &&
      (item.status === 'proposed' || typeof item.dueAt === 'number'),
  );
}

function migrateFollowUp(item: FollowUp): FollowUp {
  const reminderHistory = item.reminderHistory ??
    (item.reminderSentAt === undefined ? [] : [item.reminderSentAt]);
  return {
    ...item,
    createdById: item.createdById ?? item.ownerId,
    reminderHistory,
    overdueReminderCount: item.overdueReminderCount ?? Math.max(0, reminderHistory.length - 1),
    ...(item.status === 'pending' && item.dueAt !== undefined && item.nextReminderAt === undefined
      ? { nextReminderAt: item.reminderSentAt === undefined ? item.dueAt : undefined }
      : {}),
  };
}

function validPreferences(value: unknown): value is ProactiveUserPreferences {
  const item = value as Partial<ProactiveUserPreferences> | undefined;
  return Boolean(
    item &&
      typeof item.userId === 'string' &&
      typeof item.enabled === 'boolean' &&
      typeof item.overdueReminders === 'boolean' &&
      typeof item.dailyReminderLimit === 'number' &&
      typeof item.updatedAt === 'number' &&
      (item.quietHours === undefined ||
        (typeof item.quietHours.start === 'string' && typeof item.quietHours.end === 'string')),
  );
}

