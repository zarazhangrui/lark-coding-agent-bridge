import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type {
  FollowUp,
  ObserverMessage,
  ProactiveDecision,
  ProactiveState,
} from './types';

const EMPTY_STATE: ProactiveState = {
  version: 1,
  messages: [],
  decisions: [],
  followUps: [],
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
        version: 1,
        messages: Array.isArray(raw.messages) ? raw.messages.filter(validMessage) : [],
        decisions: Array.isArray(raw.decisions) ? raw.decisions.filter(validDecision) : [],
        followUps: Array.isArray(raw.followUps) ? raw.followUps.filter(validFollowUp) : [],
        processedMessageIds: Array.isArray(raw.processedMessageIds)
          ? raw.processedMessageIds.filter((id): id is string => typeof id === 'string')
          : [],
      };
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

  dueFollowUps(now: number): FollowUp[] {
    return this.state.followUps.filter(
      (item) =>
        item.status === 'pending' &&
        item.dueAt <= now &&
        item.reminderAttemptedAt === undefined &&
        item.reminderSentAt === undefined,
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

  snapshot(): ProactiveState {
    return structuredClone(this.state);
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

function validMessage(value: unknown): value is ObserverMessage {
  const item = value as Partial<ObserverMessage> | undefined;
  return Boolean(
    item &&
      typeof item.messageId === 'string' &&
      typeof item.chatId === 'string' &&
      (item.threadId === undefined || typeof item.threadId === 'string') &&
      typeof item.senderId === 'string' &&
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
      typeof item.dueAt === 'number' &&
      (item.status === 'pending' || item.status === 'completed' || item.status === 'cancelled'),
  );
}

