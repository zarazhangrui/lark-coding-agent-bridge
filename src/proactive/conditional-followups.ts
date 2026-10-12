import { createHash } from 'node:crypto';
import type { CardActionResponse, LarkChannel } from '@larksuite/channel';
import { cardFeedback } from '../card/feedback';
import type { ProactiveObserverConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { conditionalCard, CONDITIONAL_CARD_MARKER } from './conditional-cards';
import { conditionalCandidate, conditionalNextStep, conditionalStage } from './conditional-intent';
import { localDayBounds, nextAllowedByQuietHours } from './schedule';
import type { ProactiveStore } from './store';
import type { FollowUp, ObserverMessage, ProactiveDecision } from './types';

interface Deps {
  config: ProactiveObserverConfig;
  store: ProactiveStore;
  channel: Pick<LarkChannel, 'send'> & Partial<Pick<LarkChannel, 'updateCard'>>;
  now: () => number;
  canAct: () => boolean;
  resolveThread?: (messageId: string) => Promise<string | undefined>;
  onChanged?: (item: FollowUp) => Promise<void>;
}

/** All mutations share one queue, including callbacks racing with message intake. */
export class ConditionalFollowUps {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: Deps) {}
  private enabled(): boolean { return this.deps.config.conditionalFollowUps === true; }
  private canAct(): boolean { return this.enabled() && this.deps.canAct(); }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work); this.queue = run.catch(() => undefined); return run;
  }
  async flush(): Promise<void> { await this.queue; }

  async offer(message: ObserverMessage): Promise<Pick<ProactiveDecision, 'outcome' | 'reason' | 'targetFollowUpId'> | undefined> {
    if (!this.enabled() || !this.deps.config.allowedChats.includes(message.chatId)) return;
    const recent = this.deps.store.recentMessages(message.chatId,
      message.createTime - this.deps.config.contextWindowHours * 3600_000, 100, message.threadId);
    // Replies may point to a root with no threadId. Only an explicit reply ID
    // can cross that boundary; a random recent message can never supply it.
    const parent = message.replyToMessageId ? this.deps.store.snapshot().messages.find(m =>
      m.messageId === message.replyToMessageId && m.chatId === message.chatId) : undefined;
    const candidate = conditionalCandidate(message, parent ? [...recent, parent] : recent);
    if (!candidate) return;
    const decision: Pick<ProactiveDecision, 'outcome' | 'reason' | 'targetFollowUpId'> = { outcome: 'ignored', reason: 'conditional-suppressed' };
    await this.mutate(async () => {
      if (!this.canAct()) { decision.outcome = 'shadow'; decision.reason = 'conditional-shadow'; return; }
      const now = this.deps.now();
      const requesterPrefs = this.deps.store.preferencesFor(message.senderId);
      if (!requesterPrefs.enabled || nextAllowedByQuietHours(now, requesterPrefs, this.deps.config.timeZone) > now) return;
      if (!candidate.ownerId) {
        decision.reason = 'conditional-owner-unclear';
        await this.reply(message, '看到了“前置事项完成后再反馈”的请求，但负责人不明确。请只 @ 一位负责后续反馈的人，再发送这条请求；尚未建事项。');
        return;
      }
      const ownerPrefs = this.deps.store.preferencesFor(candidate.ownerId);
      if (!ownerPrefs.enabled || nextAllowedByQuietHours(now, ownerPrefs, this.deps.config.timeZone) > now) return;
      const { condition, ownerId } = candidate;
      const items = this.deps.store.snapshot().followUps.filter(i => i.condition);
      if (items.some(i => i.chatId === message.chatId && i.threadId === message.threadId &&
        i.ownerId === ownerId && i.createdById === message.senderId &&
        ['pending', 'proposed'].includes(i.status) && i.condition!.prerequisite === condition.prerequisite &&
        i.condition!.nextAction === condition.nextAction && i.condition!.contextMessageId === condition.contextMessageId)) { decision.reason = 'conditional-duplicate'; return; }
      const day = localDayBounds(now, this.deps.config.timeZone);
      // Bound unsolicited proposals for both the sender and recipient. Existing
      // controls remain usable after the proposal budget has been exhausted.
      if (items.filter(i => i.createdAt >= day.start && i.createdAt < day.end &&
          (i.createdById === message.senderId || i.ownerId === ownerId)).length >= 3) { decision.reason = 'conditional-proposal-limit'; return; }
      const item: FollowUp = {
        id: `fu_${createHash('sha256').update(`${message.chatId}:${message.messageId}`).digest('hex').slice(0, 16)}`,
        chatId: message.chatId, threadId: message.threadId, sourceMessageId: message.messageId,
        createdById: message.senderId, ownerId: ownerId!, condition,
        summary: `等“${condition.prerequisite}”后，${condition.nextAction}`,
        status: 'proposed', createdAt: now, updatedAt: now,
      };
      if (!this.deps.store.createFollowUp(item)) return;
      await this.render(item);
      decision.outcome = 'applied'; decision.reason = 'conditional-proposal'; decision.targetFollowUpId = item.id;
    });
    return decision;
  }

  async handleMessage(message: ObserverMessage): Promise<boolean> {
    if (!this.enabled() || !this.deps.config.allowedChats.includes(message.chatId)) return false;
    if (/^我的协作跟进[。？?！!\s]*$/.test(message.text.trim())) {
      if (this.canAct()) {
        const items = this.deps.store.snapshot().followUps.filter(i => i.condition && i.chatId === message.chatId &&
          i.threadId === message.threadId && (i.ownerId === message.senderId || i.createdById === message.senderId));
        await this.reply(message, items.slice(-10).map(i => `${i.id} · ${conditionalStage(i)}\n${i.summary}\n${conditionalNextStep(i)}`).join('\n\n') || '本话题暂无与你相关的协作跟进。');
      }
      return true;
    }
    const command = message.text.trim().match(/^(确认跟进|前置完成|前置事项(?:已)?完成(?:了)?|已反馈|已向对方反馈|取消跟进)(?:\s+(fu_[a-f0-9]{16}))?[。！!\s]*$/);
    const vague = /^(?:这个|这件事|这个事项)?(?:已经)?(?:完成了|弄好了|做好了|搞定了)[。！!\s]*$/.test(message.text.trim());
    if (!command && !vague) return false;
    const scoped = this.deps.store.snapshot().followUps.filter(i => i.condition &&
      i.chatId === message.chatId && i.threadId === message.threadId);
    const explicitId = command?.[2];
    // Existing timed reminders use the same ID format; their controls remain
    // owned by the reminder controller rather than being swallowed here.
    if (explicitId && this.deps.store.getFollowUp(explicitId) && !this.deps.store.getFollowUp(explicitId)!.condition) return false;
    const candidates = explicitId ? scoped.filter(i => i.id === explicitId) : scoped.filter(i =>
      i.ownerId === message.senderId && ['proposed', 'pending'].includes(i.status));
    if (!candidates.length && !explicitId) return false;
    await this.mutate(async () => {
      if (!this.canAct()) return;
      const item = candidates.length === 1 ? this.deps.store.getFollowUp(candidates[0]!.id) : undefined;
      if (!item) { await this.reply(message, '无法唯一确定协作事项。请在原话题带上 fu_ 编号，或操作原卡片。'); return; }
      if (vague || (!explicitId && this.deps.store.openFollowUps(message.chatId, message.threadId).some(i => !i.condition && i.ownerId === message.senderId))) {
        await this.reply(message, `“完成”可能指前置事项，也可能指后续反馈，尚未修改。${conditionalNextStep(item)}`); return;
      }
      const action = command![1] === '确认跟进' ? 'confirm' : command![1] === '取消跟进' ? 'cancel' : command![1]!.startsWith('前置') ? 'ready' : 'complete';
      if (message.createTime < (item.confirmedAt ?? item.createdAt)) {
        await this.reply(message, '这条消息早于当前确认状态，未修改事项。请使用最新卡片。'); return;
      }
      const result = await this.act(item, action, message.senderId, message.messageId);
      await this.reply(message, result.toast.content);
    });
    return true;
  }

  async handleCard(payload: Record<string, unknown>, chatId: string, operatorId: string, messageId: string): Promise<false | CardActionResponse> {
    if (!(CONDITIONAL_CARD_MARKER in payload)) return false;
    return this.mutate(async () => {
      if (!this.canAct()) return cardFeedback('协作跟进当前已暂停，未修改事项。', 'warning');
      const item = this.deps.store.getFollowUp(String(payload.followUpId ?? ''));
      if (!item?.condition || item.chatId !== chatId || item.receiptMessageId !== messageId ||
        !this.deps.config.allowedChats.includes(chatId)) return cardFeedback('卡片不在有效范围，请操作原卡片。', 'warning');
      if (payload.stage !== conditionalStage(item)) return { ...cardFeedback('状态已变化，请查看最新卡片。'), card: { type: 'raw', data: conditionalCard(item) } };
      const result = await this.act(item, String(payload.action), operatorId, messageId);
      return { ...result, card: { type: 'raw', data: conditionalCard(item) } };
    });
  }

  private async act(item: FollowUp, action: string, operatorId: string, evidenceId: string): Promise<ReturnType<typeof cardFeedback>> {
    const creatorMayReject = action === 'cancel' && item.status === 'proposed' && item.createdById === operatorId;
    if (item.ownerId !== operatorId && !creatorMayReject) return cardFeedback('只有拟负责人可以确认和推进；请求人只能撤回未确认的提议。', 'warning');
    if (action !== 'cancel' && !this.deps.store.preferencesFor(item.ownerId).enabled) return cardFeedback('负责人已暂停主动助手，未修改事项。', 'warning');
    const now = this.deps.now();
    if (action === 'confirm' && item.status === 'proposed') {
      this.deps.store.updateFollowUp(item.id, { status: 'pending', confirmedAt: now, updatedAt: now });
    } else if (action === 'ready' && item.status === 'pending' && item.condition!.satisfiedAt === undefined) {
      this.deps.store.updateFollowUp(item.id, { condition: { ...item.condition!, satisfiedAt: now, satisfiedBy: operatorId, evidenceMessageId: evidenceId }, updatedAt: now });
    } else if (action === 'complete' && item.status === 'pending' && item.condition!.satisfiedAt !== undefined) {
      this.deps.store.updateFollowUp(item.id, { status: 'completed', updatedAt: now, resolutionMessageId: evidenceId });
    } else if (action === 'cancel' && ['pending', 'proposed'].includes(item.status)) {
      this.deps.store.updateFollowUp(item.id, { status: 'cancelled', updatedAt: now, resolutionMessageId: evidenceId });
    } else return cardFeedback(`当前为“${conditionalStage(item)}”，未重复处理。${conditionalNextStep(item)}`, 'warning');
    await this.deps.store.flush();
    await this.render(item);
    return cardFeedback(`已更新：${conditionalStage(item)}。${conditionalNextStep(item)}${item.condition!.cardSyncError ? ' 原卡同步失败，请查询“我的协作跟进”。' : ''}`, 'success');
  }

  private async render(item: FollowUp): Promise<void> {
    if (!this.canAct()) return;
    try {
      if (item.receiptMessageId) {
        if (!this.deps.channel.updateCard) throw new Error('card update unavailable');
        await this.deps.channel.updateCard(item.receiptMessageId, conditionalCard(item));
      } else if (item.receiptAttemptedAt === undefined) {
        this.deps.store.updateFollowUp(item.id, { receiptAttemptedAt: this.deps.now() });
        await this.deps.store.flush();
        const result = await this.deps.channel.send(item.chatId, { card: conditionalCard(item) }, { replyTo: item.sourceMessageId, replyInThread: true });
        if (!result.messageId) throw new Error('missing card receipt');
        this.deps.store.updateFollowUp(item.id, { receiptMessageId: result.messageId, receiptSentAt: this.deps.now() });
        // A top-level source's proposal creates a new thread. Store the real
        // thread ID so subsequent replies and recovery use that exact scope.
        if (!item.threadId && this.deps.resolveThread) {
          try { const threadId = await this.deps.resolveThread(result.messageId);
            if (threadId) this.deps.store.updateFollowUp(item.id, { threadId });
          } catch { /* Explicit card controls remain bound to the message. */ }
        }
      } else throw new Error('unconfirmed previous card send');
      this.deps.store.updateFollowUp(item.id, { condition: { ...item.condition!, cardSyncError: undefined } });
    } catch {
      this.deps.store.updateFollowUp(item.id, { condition: { ...item.condition!, cardSyncError: true } });
      log.warn('proactive', 'conditional-card-sync-failed', { followUpId: item.id });
    }
    await this.deps.store.flush();
    await this.deps.onChanged?.(item);
  }

  private async reply(message: ObserverMessage, text: string): Promise<void> {
    await this.deps.channel.send(message.chatId, { text }, { replyTo: message.messageId, replyInThread: true });
  }
}
