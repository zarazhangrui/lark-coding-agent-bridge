import { createHash } from 'node:crypto';
import type { CardActionResponse, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { cardFeedback } from '../card/feedback';
import { TASK_CARD_MARKER } from './task-cards';
import type { ProactiveObserverConfig } from '../config/profile-schema';
import { log, reportMetric } from '../core/logger';
import {
  dashboardCard,
  followUpRecordedCard,
  proposalCard,
  PROACTIVE_CARD_MARKER,
  reminderCard,
} from './cards';
import { DAY_MS, formatDueAt, parseExplicitDueAt, parsePostponeDueAt } from './due';
import type { ProactiveHistorySource } from './history';
import { isProactiveObserverGloballyDisabled } from './kill-switch';
import { ProactiveStore } from './store';
import { ProactiveTaskController, type TaskRuntime } from './task-controller';
import { ConditionalFollowUps } from './conditional-followups';
import {
  localDayBounds,
  nextAllowedByQuietHours,
  parseQuietHours,
  quickDueAt,
} from './schedule';
import type {
  DecisionProvider,
  DecisionResult,
  FollowUp,
  ObserverMessage,
  ProactiveAction,
  ProactiveDecision,
} from './types';

const RECONCILIATION_INTERVAL_MS = 30_000;
const MAX_RECENT_THREADS = 10;

type PreferenceCommand =
  | { kind: 'enabled'; value: boolean }
  | { kind: 'overdue'; value: boolean }
  | { kind: 'daily-limit'; value: number }
  | { kind: 'quiet-hours'; value?: { start: string; end: string } };

export interface ProactiveControllerDeps {
  config: ProactiveObserverConfig;
  channel: Pick<LarkChannel, 'send'> & Partial<Pick<LarkChannel, 'updateCard'>>;
  store: ProactiveStore;
  decisionProvider: DecisionProvider;
  historySource?: ProactiveHistorySource;
  /** Called after a missed push event is durably recovered from history. */
  onGapDetected?: (recovered: number) => void;
  now?: () => number;
  globallyDisabled?: () => boolean;
  taskRuntime?: TaskRuntime;
  resolveTaskThread?: (messageId: string) => Promise<string | undefined>;
}

export class ProactiveController {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private reminderQueue: Promise<void> = Promise.resolve();
  private tickQueue: Promise<void> = Promise.resolve();
  private readonly allowedChats: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly globallyDisabled: () => boolean;
  private recoverySince: number | undefined;
  private lastReconciliationAt = 0;
  readonly tasks?: ProactiveTaskController;
  private readonly conditional: ConditionalFollowUps;

  constructor(private readonly deps: ProactiveControllerDeps) {
    this.allowedChats = new Set(deps.config.allowedChats);
    this.now = deps.now ?? Date.now;
    this.globallyDisabled = deps.globallyDisabled ?? isProactiveObserverGloballyDisabled;
    this.conditional = new ConditionalFollowUps({
      ...deps, now: this.now, canAct: () => this.canAct(), resolveThread: deps.resolveTaskThread,
      onChanged: async (item) => {
        for (const senderId of new Set([item.ownerId, item.createdById ?? item.ownerId])) {
          await this.tasks?.refreshOverview({ messageId: item.sourceMessageId, chatId: item.chatId,
            threadId: item.threadId, senderId, text: '', createTime: this.now() });
        }
      },
    });
    if (deps.taskRuntime && deps.channel.updateCard) {
      this.tasks = new ProactiveTaskController({
        config: deps.config, store: deps.store,
        channel: deps.channel as Pick<LarkChannel, 'send' | 'updateCard'>,
        runtime: deps.taskRuntime, now: this.now, canAct: () => this.canAct(), resolveThread: deps.resolveTaskThread,
      });
    }
  }

  async load(): Promise<void> {
    await this.deps.store.load();
    const latest = this.deps.store.latestMessageTime();
    // Keep a small overlap for eventually-consistent history results. On a
    // brand-new ledger, start at boot instead of acting on an old backlog.
    this.recoverySince = latest === undefined ? this.now() : Math.max(0, latest - 60_000);
  }

  handles(msg: NormalizedMessage): boolean {
    return (
      this.isEnabled() &&
      msg.chatType !== 'p2p' &&
      !msg.mentionedBot &&
      (msg.rawContentType === 'text' || msg.rawContentType === 'post') &&
      msg.content.trim() !== '' &&
      this.allowedChats.has(msg.chatId)
    );
  }

  enqueue(msg: NormalizedMessage): void {
    this.queue = this.queue
      .then(() => this.observe(msg))
      .catch((err: unknown) => log.fail('proactive', err, { step: 'observe' }));
  }

  start(): void {
    if (this.timer || !this.isEnabled()) return;
    void this.tasks?.recover().catch((err) => log.fail('proactive', err, { step: 'task-recovery' }));
    this.timer = setInterval(
      () => void this.runTick().catch((err) => log.fail('proactive', err, { step: 'tick' })),
      this.deps.config.pollIntervalMs,
    );
    this.timer.unref?.();
    void this.runTick().catch((err) => log.fail('proactive', err, { step: 'initial-tick' }));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tasks?.stop();
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.reminderQueue;
    await this.tickQueue;
    await this.tasks?.flush();
    await this.conditional.flush();
    await this.deps.store.flush();
  }

  async runReconciliation(): Promise<number> {
    if (!this.isEnabled() || !this.deps.historySource) return 0;
    const cycleStartedAt = this.now();
    if (cycleStartedAt - this.lastReconciliationAt < RECONCILIATION_INTERVAL_MS) return 0;
    this.lastReconciliationAt = cycleStartedAt;
    const since = this.recoverySince ?? this.now();
    let recovered = 0;

    const accept = (messages: ObserverMessage[]): void => {
      for (const message of messages) {
        if (!this.allowedChats.has(message.chatId) || this.deps.store.hasProcessed(message.messageId)) {
          continue;
        }
        recovered++;
        this.queue = this.queue
          .then(() => this.observeRecovered(message))
          .catch((err: unknown) => log.fail('proactive', err, { step: 'recover-message' }));
      }
    };

    for (const chatId of this.allowedChats) {
      try {
        accept(await this.deps.historySource.listChatRoots(chatId, since));
      } catch (err) {
        log.warn('proactive', 'history-chat-failed', { chatId, err: String(err) });
      }
    }

    await this.queue;
    const snapshot = this.deps.store.snapshot();
    const watchedThreads = new Map<string, string>();
    for (const task of snapshot.tasks) {
      if (task.threadId && this.allowedChats.has(task.chatId) &&
          !['accepted', 'cancelled'].includes(task.status)) {
        watchedThreads.set(`${task.chatId}:${task.threadId}`, task.chatId);
      }
    }
    for (const followUp of snapshot.followUps) {
      if (
        (followUp.status === 'pending' || followUp.status === 'proposed') &&
        followUp.threadId &&
        this.allowedChats.has(followUp.chatId)
      ) {
        watchedThreads.set(`${followUp.chatId}:${followUp.threadId}`, followUp.chatId);
      }
    }
    // A missed push can also be the first new commitment in a thread whose
    // previous follow-up is already closed. Keep a bounded set of recently
    // observed threads under reconciliation so that lifecycle recovery does
    // not end the moment the old item becomes completed/cancelled.
    const recentSince = cycleStartedAt - this.deps.config.contextWindowHours * 60 * 60 * 1_000;
    for (const message of [...snapshot.messages].reverse()) {
      if (
        watchedThreads.size >= MAX_RECENT_THREADS ||
        !message.threadId ||
        message.createTime < recentSince ||
        !this.allowedChats.has(message.chatId)
      ) {
        continue;
      }
      watchedThreads.set(`${message.chatId}:${message.threadId}`, message.chatId);
    }
    for (const [key, chatId] of watchedThreads) {
      const threadId = key.slice(chatId.length + 1);
      try {
        accept(await this.deps.historySource.listThread(chatId, threadId, since));
      } catch (err) {
        log.warn('proactive', 'history-thread-failed', { chatId, threadId, err: String(err) });
      }
    }

    await this.queue;
    await this.deps.store.flush();
    // Retain five minutes of overlap so late history indexing cannot create a
    // blind spot. Processed-message ids make repeat reads harmless.
    this.recoverySince = Math.max(since, cycleStartedAt - 5 * 60_000);
    if (recovered > 0) {
      log.warn('proactive', 'history-gap-recovered', { recovered });
      reportMetric('proactive_history_recovered', recovered);
      // A recovered confirmation may have just started a task. Reconnecting
      // would stop that worker and a second observer would misclassify it as
      // interrupted. History reconciliation remains available until idle.
      if (!this.deps.store.snapshot().tasks.some((task) => task.status === 'running' || task.status === 'publishing')) {
        this.deps.onGapDetected?.(recovered);
      }
    }
    return recovered;
  }

  async handleCardAction(
    payload: Record<string, unknown>,
    chatId: string,
    operatorId: string,
    messageId: string,
  ): Promise<boolean | CardActionResponse> {
    const conditionalResult = await this.conditional.handleCard(payload, chatId, operatorId, messageId);
    if (conditionalResult) return conditionalResult;
    const taskResult = await this.tasks?.handleCard(payload, chatId, operatorId, messageId);
    if (taskResult) return taskResult;
    if (TASK_CARD_MARKER in payload) return cardFeedback('主动执行当前不可用，未启动任务。', 'warning');
    if (!(PROACTIVE_CARD_MARKER in payload)) return false;
    // Consume our own marker while disabled/Shadow, but leave the ledger
    // untouched. Historical cards therefore cannot bypass a rollback.
    if (!this.canAct()) return true;
    if (!this.allowedChats.has(chatId)) {
      log.warn('proactive', 'card-denied-chat', { chatId });
      return true;
    }
    const id = typeof payload.followUpId === 'string' ? payload.followUpId : '';
    const action = payload.action;
    const item = this.deps.store.getFollowUp(id);
    if (item?.condition) return cardFeedback('请使用协作跟进卡片，不可用定时提醒按钮操作。', 'warning');
    if (
      !item ||
      item.chatId !== chatId ||
      (item.status !== 'pending' && item.status !== 'proposed')
    ) return true;
    const creatorMayReject =
      item.status === 'proposed' && action === 'cancel' && item.createdById === operatorId;
    if (item.ownerId !== operatorId && !creatorMayReject) {
      log.warn('proactive', 'card-denied-owner', { followUpId: id, operatorId });
      return true;
    }

    const now = this.now();
    let updated: FollowUp | undefined;
    if (action === 'complete' || action === 'cancel') {
      updated = this.deps.store.updateFollowUp(id, {
        status: action === 'complete' ? 'completed' : 'cancelled',
        updatedAt: now,
        resolutionMessageId: messageId,
      });
    } else if (action === 'postpone' && item.status === 'pending') {
      const dueAt = now + DAY_MS;
      updated = this.deps.store.updateFollowUp(id, {
        dueAt,
        nextReminderAt: dueAt,
        updatedAt: now,
        reminderAttemptedAt: undefined,
        reminderSentAt: undefined,
        reminderMessageId: undefined,
        overdueReminderCount: 0,
        resolutionMessageId: messageId,
      });
    } else if (
      item.status === 'proposed' &&
      (action === 'accept' ||
        action === 'confirm-today' ||
        action === 'confirm-tomorrow' ||
        action === 'confirm-next-week')
    ) {
      const dueAt = action === 'accept'
        ? item.dueAt
        : quickDueAt(
            action === 'confirm-today'
              ? 'today'
              : action === 'confirm-tomorrow'
                ? 'tomorrow'
                : 'next-week',
            now,
            this.deps.config.timeZone,
          );
      if (dueAt === undefined) return true;
      updated = this.deps.store.updateFollowUp(id, {
        status: 'pending',
        dueAt,
        nextReminderAt: dueAt,
        confirmedAt: now,
        updatedAt: now,
        resolutionMessageId: messageId,
      });
    } else {
      return true;
    }
    await this.deps.store.flush();
    if (updated) {
      if (updated.status === 'pending' && item.status === 'proposed') {
        await this.sendTextReply(
          updated.chatId,
          updated.threadId,
          messageId,
          `✅ 已确认跟进：${updated.summary}\n提醒时间：${formatDueAt(updated.dueAt!, this.deps.config.timeZone)}`,
          'proposal-confirmed',
        );
      } else {
        await this.sendActionConfirmation(updated, action as ProactiveAction, messageId);
      }
    }
    log.info('proactive', 'card-applied', { action, followUpId: id, operatorId });
    reportMetric('proactive_action', 1, { action: String(action) });
    return true;
  }

  async runDueReminders(): Promise<void> {
    const run = this.reminderQueue.then(() => this.runDueRemindersOnce());
    this.reminderQueue = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<void> {
    const run = this.tickQueue.then(async () => {
      await this.runReconciliation();
      await this.runDueReminders();
    });
    this.tickQueue = run.catch(() => undefined);
    return run;
  }

  private async runDueRemindersOnce(): Promise<void> {
    if (!this.canAct()) return;
    for (const item of this.deps.store.dueFollowUps(this.now())) {
      if (!this.allowedChats.has(item.chatId)) {
        log.warn('proactive', 'reminder-denied-chat', { followUpId: item.id, chatId: item.chatId });
        continue;
      }
      const preferences = this.deps.store.preferencesFor(
        item.ownerId,
        this.deps.config.defaultDailyReminderLimit,
      );
      if (!preferences.enabled) continue;
      if (
        item.reminderSentAt !== undefined &&
        (!preferences.overdueReminders ||
          (item.overdueReminderCount ?? 0) >= this.deps.config.overdueReminderMaxCount)
      ) {
        this.deps.store.updateFollowUp(item.id, {
          nextReminderAt: undefined,
          updatedAt: this.now(),
        });
        continue;
      }
      const now = this.now();
      const quietHoursEnd = nextAllowedByQuietHours(
        now,
        preferences,
        this.deps.config.timeZone,
      );
      if (quietHoursEnd > now) {
        this.deps.store.updateFollowUp(item.id, {
          nextReminderAt: quietHoursEnd,
          updatedAt: now,
        });
        continue;
      }
      const day = localDayBounds(now, this.deps.config.timeZone);
      if (
        this.deps.store.remindersSentBy(item.ownerId, day.start, day.end) >=
        preferences.dailyReminderLimit
      ) {
        this.deps.store.updateFollowUp(item.id, {
          nextReminderAt: nextAllowedByQuietHours(
            day.end,
            preferences,
            this.deps.config.timeZone,
          ),
          updatedAt: now,
        });
        continue;
      }
      const attemptedAt = this.now();
      this.deps.store.updateFollowUp(item.id, {
        reminderAttemptedAt: attemptedAt,
        updatedAt: attemptedAt,
      });
      // The claim must be durable before delivery. Feishu explicitly does not
      // provide idempotent message creation, so retrying an ambiguous failure
      // can produce duplicate reminders after a crash or lost response.
      await this.deps.store.flush();

      const claimed = this.deps.store.getFollowUp(item.id);
      if (
        !claimed ||
        claimed.status !== 'pending' ||
        claimed.dueAt === undefined ||
        (claimed.nextReminderAt ?? claimed.dueAt) > this.now() ||
        claimed.reminderAttemptedAt !== attemptedAt
      ) {
        continue;
      }

      const history = claimed.reminderHistory ?? [];
      const overdue = claimed.reminderSentAt !== undefined;
      const result = await this.deps.channel.send(
        claimed.chatId,
        { card: reminderCard(claimed, this.deps.config.timeZone, overdue) },
        { replyTo: claimed.sourceMessageId, replyInThread: true },
      );
      await this.rememberReplyThread(claimed, result.messageId);
      const sentAt = this.now();
      const overdueReminderCount =
        (claimed.overdueReminderCount ?? 0) + (overdue ? 1 : 0);
      const shouldChase =
        preferences.overdueReminders &&
        overdueReminderCount < this.deps.config.overdueReminderMaxCount;
      this.deps.store.updateFollowUp(item.id, {
        reminderAttemptedAt: undefined,
        reminderSentAt: sentAt,
        reminderMessageId: result.messageId,
        reminderHistory: [...history, sentAt],
        overdueReminderCount,
        nextReminderAt: shouldChase
          ? sentAt + this.deps.config.overdueReminderIntervalMinutes * 60_000
          : undefined,
        updatedAt: sentAt,
      });
      await this.deps.store.flush();
      reportMetric('proactive_reminder_sent', 1, { mode: this.deps.config.mode });
      log.info('proactive', 'reminder-sent', {
        followUpId: item.id,
        chatId: item.chatId,
        threaded: Boolean(claimed.threadId),
      });
    }
  }

  private async observe(msg: NormalizedMessage): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.deps.store.hasProcessed(msg.messageId)) {
      log.info('proactive', 'skip-duplicate-message', { msgId: msg.messageId });
      return;
    }
    const message: ObserverMessage = {
      messageId: msg.messageId,
      chatId: msg.chatId,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      mentions: msg.mentions
        .filter((mention) => !mention.isBot)
        .map((mention) => ({
          id: mention.openId ?? mention.userId ?? mention.key,
          ...(mention.name ? { name: mention.name } : {}),
        }))
        .filter((mention) => mention.id !== ''),
      text: msg.content.trim(),
      createTime: msg.createTime,
    };
    this.deps.store.recordMessage(message);
    const now = this.now();

    // Acknowledgement is context, not permission or a new follow-up. Avoid a
    // model call entirely for these whole-message, non-action utterances.
    if (/^(?:(?:好的?|收到|谢谢|感谢|明白了?|知道了|嗯+|哈+|ok|okay|thanks)|[\s，,。.!！👍🙏])+$/iu.test(message.text)) {
      this.recordDecision(message, 'ignore', 1, 'ignored', undefined, 'quiet-acknowledgement');
      return;
    }

    if (await this.conditional.handleMessage(message)) {
      this.recordDecision(message, 'clarify', 1, this.canAct() ? 'applied' : 'shadow', undefined, 'conditional-control');
      return;
    }

    if (await this.tasks?.handleMessage(message)) {
      this.recordDecision(message, 'possible-complex-task', 1, this.canAct() ? 'applied' : 'shadow', undefined, 'task-command');
      return;
    }

    const preferenceCommand = parsePreferenceCommand(message.text);
    if (preferenceCommand) {
      if (!this.canAct()) {
        this.recordDecision(message, 'settings', 1, 'shadow');
        return;
      }
      const confirmation = this.applyPreferenceCommand(message.senderId, preferenceCommand, now);
      this.recordDecision(message, 'settings', 1, 'applied');
      await this.sendTextReply(
        message.chatId,
        message.threadId,
        message.messageId,
        confirmation,
        'preferences-updated',
      );
      return;
    }

    if (isDashboardRequest(message.text)) {
      if (!this.canAct()) {
        this.recordDecision(message, 'list', 1, 'shadow');
        return;
      }
      this.recordDecision(message, 'list', 1, 'applied');
      await this.sendDashboard(message);
      return;
    }

    const preferences = this.deps.store.preferencesFor(
      message.senderId,
      this.deps.config.defaultDailyReminderLimit,
    );
    if (!preferences.enabled) {
      this.recordDecision(message, 'ignore', 1, 'ignored', undefined, 'user-paused');
      return;
    }

    let result: DecisionResult;
    try {
      result = await this.deps.decisionProvider.decide({
        message,
        recentMessages: this.deps.store
          .recentMessages(
            msg.chatId,
            now - this.deps.config.contextWindowHours * 60 * 60 * 1_000,
            this.deps.config.contextMessages + 1,
            msg.threadId,
          )
          .filter((item) => item.messageId !== message.messageId)
          .slice(-this.deps.config.contextMessages),
        pendingFollowUps: this.deps.store.openFollowUps(msg.chatId, msg.threadId),
        now,
        executionEnabled: this.tasks?.enabled() ?? false,
        ongoingTasks: this.tasks?.continuityContext(message),
      });
    } catch (err) {
      if (await this.tasks?.observeUpdate(message)) {
        this.recordDecision(message, 'possible-complex-task', 0, this.canAct() ? 'applied' : 'shadow', undefined, 'task-update-fallback');
        return;
      }
      const conditional = await this.conditional.offer(message);
      if (conditional) {
        this.recordDecision(message, 'clarify', 0, conditional.outcome, conditional.targetFollowUpId, conditional.reason);
        return;
      }
      if (await this.tasks?.offer(message, { action: 'ignore', confidence: 0 })) {
        this.recordDecision(message, 'possible-complex-task', 0, this.canAct() ? 'applied' : 'shadow', undefined, 'explicit-task-fallback');
        return;
      }
      this.recordDecision(message, 'ignore', 0, 'failed', undefined, String(err));
      log.warn('proactive', 'decision-failed', { msgId: msg.messageId, err: String(err) });
      return;
    }

    if (await this.tasks?.observeUpdate(message, result)) {
      this.recordDecision(message, 'possible-complex-task', result.continuation?.confidence ?? 1, this.canAct() ? 'applied' : 'shadow', undefined, 'task-update');
      return;
    }
    const conditional = await this.conditional.offer(message);
    if (conditional) {
      this.recordDecision(message, 'clarify', result.confidence, conditional.outcome, conditional.targetFollowUpId, conditional.reason);
      return;
    }
    if (await this.tasks?.offer(message, result)) {
      this.recordDecision(message, 'possible-complex-task', result.confidence, this.canAct() ? 'applied' : 'shadow', undefined, 'task-proposal');
      return;
    }

    // A clear but incomplete commitment is a reversible confirmation
    // candidate even when the classifier underrates it as ordinary chat.
    // It never becomes an active reminder without a user/card confirmation.
    if (
      result.action === 'ignore' &&
      isCommitmentCandidate(message.text) &&
      (parseExplicitDueAt(message.text, now, this.deps.config.timeZone) === undefined ||
        soleAssignee(message) !== undefined)
    ) {
      result = { ...result, action: 'clarify' };
    }

    const pendingFollowUps = this.deps.store.openFollowUps(
      message.chatId,
      message.threadId,
    );
    // Model uncertainty alone is not a reason to interrupt a conversation.
    // Keep controls for an existing item; new proposals need grounded intent.
    if ((result.action === 'create' || result.action === 'clarify') &&
        (isConversationalNonCommitment(message.text) ||
          (result.action === 'clarify' && !isCommitmentCandidate(message.text) &&
            !(pendingFollowUps.length && /完成|取消|延期|推迟|改到|再提醒/.test(message.text))))) {
      this.recordDecision(message, result.action, result.confidence, 'ignored', undefined, 'quiet-no-action-intent');
      return;
    }
    const deterministicTarget = selectTarget(message.text, pendingFollowUps);
    if (
      result.action !== 'postpone' &&
      deterministicTarget?.ownerId === message.senderId &&
      hasExplicitPostponeIntent(message.text) &&
      parsePostponeDueAt(message.text, now, this.deps.config.timeZone) !== undefined
    ) {
      result = { ...result, action: 'postpone' };
    }
    const deterministicOverride = hasDeterministicLowRiskEvidence(
      result.action,
      message,
      pendingFollowUps,
      now,
      this.deps.config,
    );
    if (
      (result.confidence < this.deps.config.shadowThreshold && !deterministicOverride) ||
      result.action === 'ignore'
    ) {
      this.recordDecision(message, result.action, result.confidence, 'ignored');
      return;
    }
    const requiredConfidence = confidenceThresholdFor(
      result.action,
      message,
      pendingFollowUps,
      now,
      this.deps.config,
    );
    if (
      this.deps.config.mode === 'shadow' ||
      (result.confidence < requiredConfidence && !deterministicOverride)
    ) {
      this.recordDecision(message, result.action, result.confidence, 'shadow');
      if (this.deps.config.mode === 'active') {
        await this.sendUnappliedFeedback(message, result.action, now, 'action-deferred');
      }
      return;
    }

    const target = this.applyAction(message, result.action, now);
    this.recordDecision(
      message,
      result.action,
      result.confidence,
      target.applied ? 'applied' : 'ignored',
      target.followUpId,
      target.reason ??
        (deterministicOverride && result.confidence < requiredConfidence
          ? 'deterministic-low-risk-evidence'
          : undefined),
    );
    if (
      (result.action === 'create' || result.action === 'clarify') &&
      target.applied &&
      target.followUpId
    ) {
      const item = this.deps.store.getFollowUp(target.followUpId);
      if (item?.status === 'proposed') await this.sendProposal(item);
      else await this.sendRecordedReceipt(target.followUpId);
    } else if (target.applied && target.followUpId) {
      const item = this.deps.store.getFollowUp(target.followUpId);
      if (item) await this.sendActionConfirmation(item, result.action, message.messageId);
    } else {
      await this.sendUnappliedFeedback(
        message,
        result.action,
        now,
        'action-unapplied',
        target.reason,
      );
    }
  }

  private async sendActionConfirmation(
    item: FollowUp,
    action: ProactiveAction,
    replyTo: string,
  ): Promise<void> {
    let text: string | undefined;
    if (action === 'complete') text = `✅ 已完成：${item.summary}`;
    else if (action === 'cancel') text = `🚫 已取消跟进：${item.summary}`;
    else if (action === 'postpone' && item.dueAt !== undefined) {
      text = `⏰ 已延期至 ${formatDueAt(item.dueAt, this.deps.config.timeZone)}：${item.summary}`;
    }
    if (text) await this.sendTextReply(item.chatId, item.threadId, replyTo, text, 'action-confirmed');
  }

  private async sendUnappliedFeedback(
    message: ObserverMessage,
    action: ProactiveAction,
    now: number,
    event: string,
    reason?: string,
  ): Promise<void> {
    const pending = this.deps.store.openFollowUps(message.chatId, message.threadId);
    const target = selectTarget(message.text, pending);
    const text = feedbackForUnavailableAction(
      action,
      message,
      target,
      reason,
      now,
      this.deps.config.timeZone,
    );
    if (text) {
      await this.sendTextReply(
        message.chatId,
        message.threadId,
        message.messageId,
        text,
        event,
      );
    }
  }

  private async sendTextReply(
    chatId: string,
    threadId: string | undefined,
    replyTo: string,
    text: string,
    event: string,
  ): Promise<void> {
    try {
      await this.deps.channel.send(
        chatId,
        { text },
        { replyTo, replyInThread: true },
      );
      log.info('proactive', event, { chatId, threaded: true });
    } catch (err) {
      log.warn('proactive', `${event}-failed`, { chatId, err: String(err) });
    }
  }

  private applyPreferenceCommand(
    userId: string,
    command: PreferenceCommand,
    now: number,
  ): string {
    if (command.kind === 'enabled') {
      this.deps.store.updatePreferences(
        userId,
        { enabled: command.value, updatedAt: now },
        this.deps.config.defaultDailyReminderLimit,
      );
      return command.value ? '✅ 已恢复主动跟进。' : '⏸️ 已暂停你的主动跟进；已有事项会保留，期间不会主动提醒。';
    }
    if (command.kind === 'overdue') {
      this.deps.store.updatePreferences(
        userId,
        { overdueReminders: command.value, updatedAt: now },
        this.deps.config.defaultDailyReminderLimit,
      );
      return command.value ? '✅ 已开启逾期追问。' : '✅ 已关闭逾期追问；到期提醒仍会保留。';
    }
    if (command.kind === 'daily-limit') {
      this.deps.store.updatePreferences(
        userId,
        { dailyReminderLimit: command.value, updatedAt: now },
        this.deps.config.defaultDailyReminderLimit,
      );
      return `✅ 每日主动提醒上限已设为 ${command.value} 次。`;
    }
    this.deps.store.updatePreferences(
      userId,
      { quietHours: command.value, updatedAt: now },
      this.deps.config.defaultDailyReminderLimit,
    );
    return command.value
      ? `✅ 免打扰时段已设为 ${command.value.start}–${command.value.end}。`
      : '✅ 已取消免打扰时段。';
  }

  private async sendDashboard(message: ObserverMessage): Promise<void> {
    const now = this.now();
    const items = this.deps.store.userFollowUps(message.senderId).filter(i =>
      !i.condition || (i.chatId === message.chatId && i.threadId === message.threadId));
    const completedSince = now - 7 * DAY_MS;
    const day = localDayBounds(now, this.deps.config.timeZone);
    const dueSoonEnd = Math.max(
      day.end,
      now + this.deps.config.dueSoonMinutes * 60_000,
    );
    const groups = [
      {
        title: '待确认',
        items: items.filter((item) => item.status === 'proposed'),
      },
      {
        title: '已逾期',
        items: items.filter(
          (item) => item.status === 'pending' && item.dueAt !== undefined && item.dueAt < now,
        ),
      },
      { title: '等待前置事项', items: items.filter(i => i.condition && i.status === 'pending' && i.condition.satisfiedAt === undefined) },
      { title: '待后续反馈', items: items.filter(i => i.condition && i.status === 'pending' && i.condition.satisfiedAt !== undefined) },
      {
        title: '今天到期',
        items: items.filter(
          (item) =>
            item.status === 'pending' &&
            item.dueAt !== undefined &&
            item.dueAt >= now &&
            item.dueAt < day.end,
        ),
      },
      {
        title: '即将到期',
        items: items.filter(
          (item) =>
            item.status === 'pending' &&
            item.dueAt !== undefined &&
            item.dueAt >= day.end &&
            item.dueAt <= dueSoonEnd,
        ),
      },
      {
        title: '未来',
        items: items.filter(
          (item) =>
            item.status === 'pending' &&
            item.dueAt !== undefined &&
            item.dueAt > dueSoonEnd,
        ),
      },
      {
        title: '最近完成',
        items: items.filter(
          (item) => item.status === 'completed' && item.updatedAt >= completedSince,
        ),
      },
      {
        title: '最近取消',
        items: items.filter(
          (item) => item.status === 'cancelled' && item.updatedAt >= completedSince,
        ),
      },
    ];
    await this.deps.channel.send(
      message.chatId,
      { card: dashboardCard(groups, this.deps.config.timeZone) },
      {
        replyTo: message.messageId,
        replyInThread: true,
      },
    );
  }

  private async sendProposal(item: FollowUp): Promise<void> {
    if (item.receiptAttemptedAt !== undefined) return;
    const attemptedAt = this.now();
    this.deps.store.updateFollowUp(item.id, { receiptAttemptedAt: attemptedAt, updatedAt: attemptedAt });
    await this.deps.store.flush();
    try {
      const result = await this.deps.channel.send(
        item.chatId,
        {
          card: proposalCard(
            item,
            (item.createdById ?? item.ownerId) !== item.ownerId,
            this.deps.config.timeZone,
          ),
        },
        {
          replyTo: item.sourceMessageId,
          replyInThread: true,
        },
      );
      const sentAt = this.now();
      this.deps.store.updateFollowUp(item.id, {
        receiptSentAt: sentAt,
        receiptMessageId: result.messageId,
        updatedAt: sentAt,
      });
      await this.rememberReplyThread(item, result.messageId);
      await this.deps.store.flush();
    } catch (err) {
      log.warn('proactive', 'proposal-card-failed', { followUpId: item.id, err: String(err) });
    }
  }

  private async sendRecordedReceipt(followUpId: string): Promise<void> {
    const item = this.deps.store.getFollowUp(followUpId);
    if (!item || item.status !== 'pending' || item.receiptAttemptedAt !== undefined) return;

    const attemptedAt = this.now();
    this.deps.store.updateFollowUp(followUpId, {
      receiptAttemptedAt: attemptedAt,
      updatedAt: attemptedAt,
    });
    await this.deps.store.flush();

    try {
      const result = await this.deps.channel.send(
        item.chatId,
        { card: followUpRecordedCard(item, this.deps.config.timeZone) },
        {
          replyTo: item.sourceMessageId,
          replyInThread: true,
        },
      );
      const sentAt = this.now();
      this.deps.store.updateFollowUp(followUpId, {
        receiptSentAt: sentAt,
        receiptMessageId: result.messageId,
        updatedAt: sentAt,
      });
      await this.rememberReplyThread(item, result.messageId);
      await this.deps.store.flush();
      log.info('proactive', 'follow-up-recorded', {
        followUpId,
        chatId: item.chatId,
        threaded: Boolean(item.threadId),
      });
    } catch (err) {
      log.warn('proactive', 'follow-up-receipt-failed', {
        followUpId,
        err: String(err),
      });
    }
  }

  private async rememberReplyThread(item: FollowUp, messageId: string): Promise<void> {
    if (item.threadId || !messageId || !this.deps.resolveTaskThread) return;
    try {
      const threadId = await this.deps.resolveTaskThread(messageId);
      if (threadId) this.deps.store.updateFollowUp(item.id, { threadId });
    } catch {
      // A lookup failure must not resend a successfully delivered card.
      log.warn('proactive', 'reply-thread-lookup-failed', { followUpId: item.id });
    }
  }

  private observeRecovered(message: ObserverMessage): Promise<void> {
    return this.observe({
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: 'group',
      senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      content: message.text,
      rawContentType: 'text',
      resources: [],
      mentions: (message.mentions ?? []).map((mention, index) => ({
        key: `@_user_${index + 1}`,
        openId: mention.id,
        name: mention.name,
        isBot: false,
      })),
      mentionAll: false,
      mentionedBot: false,
      createTime: message.createTime,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    });
  }

  private applyAction(
    message: ObserverMessage,
    action: ProactiveAction,
    now: number,
  ): { applied: boolean; followUpId?: string; reason?: string } {
    if (action === 'create' || action === 'clarify') {
      const dueAt = parseExplicitDueAt(message.text, now, this.deps.config.timeZone);
      if (
        (action === 'clarify' && !isCommitmentCandidate(message.text)) ||
        (dueAt === undefined && !isCommitmentCandidate(message.text))
      ) {
        return { applied: false, reason: action === 'clarify' ? 'needs-clarification' : 'missing-explicit-due' };
      }
      const assignee = soleAssignee(message);
      const ownerId = assignee?.id ?? message.senderId;
      const assignedToOther = ownerId !== message.senderId;
      const status =
        action === 'clarify' || dueAt === undefined || assignedToOther ? 'proposed' : 'pending';
      const id = `fu_${createHash('sha256')
        .update(`${message.chatId}:${message.messageId}`)
        .digest('hex')
        .slice(0, 16)}`;
      const created = this.deps.store.createFollowUp({
        id,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        sourceMessageId: message.messageId,
        summary: summarize(message.text),
        createdById: message.senderId,
        ownerId,
        ...(dueAt === undefined ? {} : { dueAt }),
        status,
        ...(status === 'pending' && dueAt !== undefined
          ? { nextReminderAt: dueAt, confirmedAt: now }
          : {}),
        reminderHistory: [],
        overdueReminderCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return created
        ? { applied: true, followUpId: id }
        : { applied: false, followUpId: id, reason: 'duplicate-follow-up' };
    }

    if (action === 'complete' || action === 'cancel' || action === 'postpone') {
      const target = selectTarget(
        message.text,
        this.deps.store.openFollowUps(message.chatId, message.threadId),
      );
      if (!target) return { applied: false, reason: 'no-unambiguous-target' };
      if (target.condition) return { applied: false, followUpId: target.id, reason: 'conditional-control-required' };
      if (target.ownerId !== message.senderId) {
        return { applied: false, followUpId: target.id, reason: 'owner-mismatch' };
      }
      if (action === 'postpone') {
        if (!hasExplicitPostponeIntent(message.text)) {
          return {
            applied: false,
            followUpId: target.id,
            reason: 'missing-explicit-postpone-intent',
          };
        }
        const dueAt = parsePostponeDueAt(message.text, now, this.deps.config.timeZone);
        if (dueAt === undefined) return { applied: false, reason: 'missing-explicit-due' };
        this.deps.store.updateFollowUp(target.id, {
          status: 'pending',
          dueAt,
          nextReminderAt: dueAt,
          confirmedAt: target.confirmedAt ?? now,
          reminderAttemptedAt: undefined,
          reminderSentAt: undefined,
          reminderMessageId: undefined,
          overdueReminderCount: 0,
          updatedAt: now,
          resolutionMessageId: message.messageId,
        });
      } else {
        this.deps.store.updateFollowUp(target.id, {
          status: action === 'complete' ? 'completed' : 'cancelled',
          updatedAt: now,
          resolutionMessageId: message.messageId,
        });
      }
      return { applied: true, followUpId: target.id };
    }

    if (action === 'possible-complex-task') {
      return { applied: false, reason: 'agent-escalation-disabled' };
    }
    return { applied: false, reason: 'no-op' };
  }

  private isEnabled(): boolean {
    return this.deps.config.enabled && !this.globallyDisabled();
  }

  private canAct(): boolean {
    return this.isEnabled() && this.deps.config.mode === 'active';
  }

  private recordDecision(
    message: ObserverMessage,
    action: ProactiveAction,
    confidence: number,
    outcome: ProactiveDecision['outcome'],
    targetFollowUpId?: string,
    reason?: string,
  ): void {
    this.deps.store.recordDecision({
      messageId: message.messageId,
      chatId: message.chatId,
      action,
      confidence,
      outcome,
      decidedAt: this.now(),
      ...(targetFollowUpId ? { targetFollowUpId } : {}),
      ...(reason ? { reason } : {}),
    });
    reportMetric('proactive_decision', 1, { action, outcome });
  }
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

function selectTarget(text: string, pending: FollowUp[]): FollowUp | undefined {
  if (pending.length === 1) return pending[0];
  const normalized = normalizeTokens(text);
  const scored = pending
    .map((item) => ({ item, score: overlap(normalized, normalizeTokens(item.summary)) }))
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  if (!scored[0] || scored[0].score === 0) return undefined;
  if (scored[1] && scored[1].score === scored[0].score) return undefined;
  return scored[0].item;
}

function normalizeTokens(value: string): Set<string> {
  const cleaned = value
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）()\s]/g, '')
    .replace(/(完成|取消|延期|推迟|搞定|明天|后天|今天|提醒|跟进)/g, '');
  const tokens = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) tokens.add(cleaned.slice(i, i + 2));
  return tokens;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

function confidenceThresholdFor(
  action: ProactiveAction,
  message: ObserverMessage,
  pending: FollowUp[],
  now: number,
  config: ProactiveObserverConfig,
): number {
  const target = selectTarget(message.text, pending);
  switch (action) {
    case 'create':
    case 'clarify':
    case 'possible-complex-task':
    case 'list':
    case 'settings':
      return config.lowRiskActionThreshold;
    case 'postpone':
      return target?.ownerId === message.senderId &&
        hasExplicitPostponeIntent(message.text) &&
        parsePostponeDueAt(message.text, now, config.timeZone) !== undefined
        ? config.lowRiskActionThreshold
        : config.actionThreshold;
    case 'complete':
      return target?.ownerId === message.senderId
        ? config.lowRiskActionThreshold
        : config.actionThreshold;
    case 'cancel':
    case 'ignore':
      return config.actionThreshold;
  }
}

/**
 * A model score is useful for fuzzy intent, but it must not veto a reversible
 * action whose safety conditions are fully checkable in code. This is kept
 * deliberately narrow: create needs both a parseable time and explicit
 * first-person/reminder intent; postpone needs one owned target and a
 * parseable replacement time. Destructive cancellation never gets an
 * override.
 */
function hasDeterministicLowRiskEvidence(
  action: ProactiveAction,
  message: ObserverMessage,
  pending: FollowUp[],
  now: number,
  config: ProactiveObserverConfig,
): boolean {
  if (action === 'create') {
    return (
      parseExplicitDueAt(message.text, now, config.timeZone) !== undefined &&
      isCommitmentCandidate(message.text)
    );
  }
  if (action === 'clarify') {
    return isCommitmentCandidate(message.text);
  }
  if (action === 'postpone') {
    const target = selectTarget(message.text, pending);
    return (
      target?.ownerId === message.senderId &&
      hasExplicitPostponeIntent(message.text) &&
      parsePostponeDueAt(message.text, now, config.timeZone) !== undefined
    );
  }
  return false;
}

function hasExplicitFollowUpIntent(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (/(?:提醒我|通知我|叫我|帮我(?:记得)?提醒|请.{0,24}提醒我)/.test(normalized)) {
    return true;
  }
  if (/(?:这个|这份|该).{0,32}(?:跟一下|跟进一下|处理一下|确认一下|推进一下)/.test(normalized)) {
    return true;
  }
  return /(?:我|我们).{0,48}(?:完成|提交|交付|反馈|跟进|确认|处理|发送|回复|联系|更新|验收|开会|复盘|打电话)/.test(
    normalized,
  );
}

function isCommitmentCandidate(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (isConversationalNonCommitment(text)) return false;
  if (/(?:已经|已完成|完成了|搞定了|做完了|不用了|取消了|已取消)/.test(normalized)) {
    return false;
  }
  return hasExplicitFollowUpIntent(text);
}

function isConversationalNonCommitment(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (/^(?:如果|假如|假设|比如|例如|示例|引用)|(?:不用|无需|不需要|不要|别)(?:再)?(?:提醒|跟进)/.test(normalized)) return true;
  // Polite reminder requests can be questions; informational questions and
  // statements of ongoing work are not new commitments.
  if (/(?:提醒我|通知我|叫我)/.test(normalized)) return false;
  return /怎么|如何|为什么|是否|正在|[吗呢？?]$/.test(normalized);
}

function hasExplicitPostponeIntent(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(?:改到|改成|调整到|延期|延后|推迟|往后|再提醒|提醒时间.{0,8}(?:改|调整))/.test(
    normalized,
  );
}

function feedbackForUnavailableAction(
  action: ProactiveAction,
  message: ObserverMessage,
  target: FollowUp | undefined,
  reason: string | undefined,
  now: number,
  timeZone: string,
): string | undefined {
  if (reason === 'missing-explicit-due') {
    return action === 'postpone'
      ? '我识别到你想延期，但没读到明确的新时间。可以说“5 分钟后提醒我”或“延期到明天下午 3 点”。'
      : '我识别到你想设置跟进，但缺少明确时间。可以直接选择今天、明天或下周。';
  }
  if (reason === 'owner-mismatch') return '这项跟进只能由负责人修改。';
  if (reason === 'missing-explicit-postpone-intent') {
    return '我没有看到明确的延期指令。如需调整，请说“改到 5 分钟后”或“延期到明天下午 3 点”。';
  }
  if (reason === 'no-unambiguous-target') {
    return '我没能确定你指的是哪一项跟进，请带上事项名称再说一次。';
  }
  if (action === 'clarify') {
    return '我还不能确定你希望创建、延期、完成还是取消哪项跟进，请补充事项和时间。';
  }
  if (action === 'possible-complex-task') {
    // Unsupported or speculative work is not a request to interrupt the chat.
    return undefined;
  }
  if ((action === 'complete' || action === 'cancel' || action === 'postpone') && !target) {
    return '我没能确定你指的是哪一项跟进，请带上事项名称再说一次。';
  }
  if (target && target.ownerId !== message.senderId) {
    return '这项跟进只能由负责人修改。';
  }
  if (
    action === 'postpone' &&
    parsePostponeDueAt(message.text, now, timeZone) === undefined
  ) {
    return '我识别到你想延期，但没读到明确的新时间。可以说“5 分钟后提醒我”或“延期到明天下午 3 点”。';
  }
  if (action === 'cancel') {
    return '我识别到你想取消这项跟进。为避免误取消，请点击事项卡片里的“取消跟进”。';
  }
  if (action === 'complete') {
    return '我还不够确定这项是否已经完成。请说“确认完成”或点击事项卡片里的“已完成”。';
  }
  if (action === 'postpone') {
    return '我还不够确定新的提醒时间。请说“5 分钟后提醒我”或“延期到明天下午 3 点”。';
  }
  if (action === 'create') {
    return '我还不够确定是否要创建跟进。请明确说“请在具体时间提醒我”。';
  }
  return undefined;
}

function soleAssignee(message: ObserverMessage): { id: string; name?: string } | undefined {
  const distinct = [...new Map((message.mentions ?? []).map((item) => [item.id, item])).values()];
  return distinct.length === 1 ? distinct[0] : undefined;
}

function isDashboardRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(?:我的(?:主动)?跟进|我的待办|查看.{0,6}(?:跟进|待办)|列出.{0,6}(?:跟进|待办))/.test(normalized);
}

function parsePreferenceCommand(text: string): PreferenceCommand | undefined {
  const normalized = text.replace(/\s+/g, '');
  if (/(?:暂停|关闭|停用)(?:我的)?(?:主动智能体|主动跟进|主动提醒)/.test(normalized)) {
    return { kind: 'enabled', value: false };
  }
  if (/(?:恢复|开启|启用)(?:我的)?(?:主动智能体|主动跟进|主动提醒)/.test(normalized)) {
    return { kind: 'enabled', value: true };
  }
  if (/(?:关闭|不要|停止)逾期(?:追问|提醒)/.test(normalized)) {
    return { kind: 'overdue', value: false };
  }
  if (/(?:开启|恢复|需要)逾期(?:追问|提醒)/.test(normalized)) {
    return { kind: 'overdue', value: true };
  }
  const limit = normalized.match(/每天(?:最多)?提醒(\d{1,2})次/);
  if (limit?.[1]) {
    return { kind: 'daily-limit', value: Math.max(1, Math.min(100, Number(limit[1]))) };
  }
  if (/(?:取消|关闭)免打扰/.test(normalized)) {
    return { kind: 'quiet-hours', value: undefined };
  }
  if (/免打扰/.test(normalized)) {
    const quiet = parseQuietHours(text);
    if (quiet) return { kind: 'quiet-hours', value: quiet };
  }
  return undefined;
}
