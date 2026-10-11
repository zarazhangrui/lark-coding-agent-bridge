import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CardActionResponse, LarkChannel } from '@larksuite/channel';
import { cardFeedback } from '../card/feedback';
import type { ProactiveObserverConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { DAY_MS } from './due';
import { localDayBounds, nextAllowedByQuietHours } from './schedule';
import { ProactiveStore } from './store';
import { taskCard, TASK_CARD_MARKER } from './task-cards';
import type { DecisionResult, ObserverMessage, ProactiveTask, ProactiveTaskKind, TaskDraft } from './types';

export interface TaskRuntime {
  run(task: ProactiveTask, signal: AbortSignal, progress: (text: string) => Promise<void>): Promise<
    { status: 'ready'; draft: TaskDraft } | { status: 'needs_input'; question: string }
  >;
  publish(task: ProactiveTask, signal: AbortSignal, created: (id: string, url: string) => Promise<void>): Promise<string>;
}

interface TaskControllerDeps {
  config: ProactiveObserverConfig;
  store: ProactiveStore;
  channel: Pick<LarkChannel, 'send' | 'updateCard'>;
  runtime: TaskRuntime;
  canAct: () => boolean;
  now?: () => number;
  resolveThread?: (messageId: string) => Promise<string | undefined>;
}

/** Task mutation is serialized; expensive execution never blocks inbound observation. */
export class ProactiveTaskController {
  private queue = Promise.resolve();
  private readonly workers = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly now: () => number;
  private readonly cardQueues = new Map<string, Promise<void>>();
  private recovered = false;

  constructor(private readonly deps: TaskControllerDeps) { this.now = deps.now ?? Date.now; }

  enabled(): boolean { return this.deps.config.execution?.enabled === true; }
  hasActiveWork(): boolean { return this.workers.size > 0 || this.deps.store.snapshot().tasks.some((task) => task.status === 'running' || task.status === 'publishing'); }
  private canAct(): boolean { return this.enabled() && this.deps.canAct(); }

  async recover(): Promise<void> {
    if (this.recovered || !this.canAct()) return;
    this.recovered = true;
    for (const task of this.deps.store.snapshot().tasks) {
      if (!this.deps.config.allowedChats.includes(task.chatId)) continue;
      if (task.status !== 'running' && task.status !== 'publishing') continue;
      const updated = this.deps.store.updateTask(task.id, {
        status: 'failed', updatedAt: this.now(), progress: undefined,
        error: task.status === 'publishing'
          ? '服务在交付期间重启。为避免重复创建文档，已停止自动重试；请调整要求后重新确认。'
          : '服务重启中断了执行。请点击重试，或调整要求后重新确认。',
      })!;
      await this.deps.store.flush();
      await this.render(updated);
    }
  }

  async offer(message: ObserverMessage, result: DecisionResult): Promise<boolean> {
    if (!this.enabled() || !this.deps.config.allowedChats.includes(message.chatId)) return false;
    const structuredKind = result.action === 'possible-complex-task' ? result.taskKind : undefined;
    const kind = structuredKind ?? inferTaskKind(message.text);
    // The semantic decision is enough to offer a reversible card. Lexical intent
    // is only a fallback; neither path grants permission to execute the task.
    if (!kind || isExcludedTask(message.text)) return false;
    if (!structuredKind && !isTaskCandidate(message.text)) return false;
    if (result.action !== 'possible-complex-task' && !hasExplicitHelpIntent(message.text)) return false;
    if (!this.canAct()) return true;
    const now = this.now();
    const prefs = this.deps.store.preferencesFor(message.senderId);
    if (!prefs.enabled || nextAllowedByQuietHours(now, prefs, this.deps.config.timeZone) > now) return true;
    const fingerprint = taskFingerprint(message.text, kind);
    const existing = this.deps.store.tasksFor(message.chatId, message.senderId, message.threadId);
    const duplicate = existing.find((task) => task.fingerprint === fingerprint && now - task.createdAt < DAY_MS);
    if (duplicate) {
      if (hasExplicitHelpIntent(message.text)) await this.reply(message, `这条需求已有任务 ${duplicate.id}，不会重复创建。可发送“我的主动任务”查看状态。`);
      return true;
    }
    const open = existing.find((task) => ['proposed', 'needs_input', 'running', 'publishing'].includes(task.status) && task.kind === kind);
    if (open) {
      if (hasExplicitHelpIntent(message.text)) await this.reply(message, `本话题已有同类任务 ${open.id} 待处理。可先完成它，或回复“补充 ${open.id}：你的要求”后重新确认。`);
      return true;
    }
    const day = localDayBounds(now, this.deps.config.timeZone);
    const all = this.deps.store.snapshot().tasks.filter((task) => task.ownerId === message.senderId);
    if (all.filter((task) => task.createdAt >= day.start).length >= this.deps.config.execution!.dailyProposalLimit) {
      if (hasExplicitHelpIntent(message.text)) await this.reply(message, `今天的主动任务建议已达到 ${this.deps.config.execution!.dailyProposalLimit} 条上限，本次没有新建任务。已有任务仍可确认、修改或验收。`);
      return true;
    }
    if (existing.some((task) => now - task.createdAt < this.deps.config.execution!.proposalCooldownMinutes * 60_000)) {
      if (hasExplicitHelpIntent(message.text)) await this.reply(message, `为减少打扰，同一话题的任务建议间隔为 ${this.deps.config.execution!.proposalCooldownMinutes} 分钟。本次没有新建，请稍后再发；已有任务仍可操作。`);
      return true;
    }
    const context = this.deps.store.recentMessages(message.chatId, now - DAY_MS, 20, message.threadId);
    const task: ProactiveTask = {
      id: `pt_${createHash('sha256').update(`${message.chatId}:${message.messageId}`).digest('hex').slice(0, 12)}`,
      chatId: message.chatId, threadId: message.threadId, sourceMessageId: message.messageId,
      ownerId: message.senderId, kind, request: message.text.slice(0, 4000), context,
      fingerprint, revision: 1, status: 'proposed', artifacts: [], createdAt: now, updatedAt: now,
    };
    if (!this.deps.store.createTask(task)) return true;
    await this.deps.store.flush();
    await this.render(task);
    return true;
  }

  async handleCard(payload: Record<string, unknown>, chatId: string, operatorId: string, messageId: string): Promise<false | CardActionResponse> {
    if (!(TASK_CARD_MARKER in payload)) return false;
    return this.mutate(async () => {
      const deny = (reason: string, content: string): CardActionResponse => {
        log.warn('proactive-task', 'card-denied', { reason, messageId });
        return cardFeedback(content, 'warning');
      };
      if (!this.canAct()) return deny('disabled', '主动执行当前已暂停，未启动任务。');
      const task = this.deps.store.getTask(String(payload.taskId ?? ''));
      if (!task || task.chatId !== chatId || task.cardMessageId !== messageId ||
          !this.deps.config.allowedChats.includes(chatId)) return deny('binding', '这张卡片已失效或不在允许范围内，请查看原话题的最新卡片。');
      if (task.ownerId !== operatorId) return deny('owner', '只有这条需求的发起人可以操作。');
      if (task.revision !== payload.revision) return deny('revision', '要求已更新，请使用最新版本的卡片重新确认。');
      const before = task.status;
      const result = await this.act(task, String(payload.action));
      log.info('proactive-task', 'card-handled', { taskId: task.id, revision: task.revision, before, after: task.status });
      // Return the authoritative view with the click response as well. A REST
      // patch during the pending interaction alone did not reliably refresh the
      // live card. This also repairs a stale view on an authorized repeat click.
      return { ...result, card: { type: 'raw', data: taskCard(task) } };
    });
  }

  async handleMessage(message: ObserverMessage): Promise<boolean> {
    if (!this.enabled() || !this.deps.config.allowedChats.includes(message.chatId)) return false;
    if (/^(我的主动任务|任务进度)[？?！!。\s]*$/.test(message.text)) {
      if (this.canAct()) {
        const tasks = this.deps.store.tasksFor(message.chatId, message.senderId, message.threadId).slice(-5);
        await this.reply(message, tasks.length ? tasks.map((task) => `${task.id} · ${task.status}\n${task.request.slice(0, 100)}\n${task.question ?? task.error ?? task.progress ?? '等待确认'}${task.status === 'delivered' || task.status === 'accepted' ? `\n${task.documentUrl ?? ''}` : ''}`).join('\n\n') : '本话题还没有你发起的主动任务。');
      }
      return true;
    }
    const command = parseTaskCommand(message.text);
    if (!command) return false;
    await this.mutate(async () => {
      if (!this.canAct()) return;
      const tasks = this.deps.store.tasksFor(message.chatId, message.senderId, message.threadId);
      const candidates = command.id ? tasks.filter((task) => task.id === command.id) :
        tasks.filter((task) => !['accepted', 'cancelled'].includes(task.status));
      const task = candidates.length === 1 ? candidates[0] : undefined;
      if (!task) {
        if (tasks.length || command.id) await this.reply(message, '请带上任务编号，例如“开始 pt_…”。只能操作你在本话题发起的任务。');
        return;
      }
      if (command.action === 'supplement') {
        if (!command.text || !['proposed', 'needs_input', 'delivered', 'failed'].includes(task.status)) return;
        if (task.reviewFollowUpId) this.deps.store.updateFollowUp(task.reviewFollowUpId, { status: 'cancelled', updatedAt: this.now() });
        // Changes revoke prior confirmation and require a new explicit start.
        this.deps.store.updateTask(task.id, {
          request: `${task.request}\n补充要求：${command.text}`.slice(-8000),
          context: [...task.context, message].slice(-20), revision: task.revision + 1,
          status: 'proposed', question: undefined, error: undefined, progress: undefined,
          confirmedAt: undefined, confirmedBy: undefined, publicationAttemptedAt: undefined,
          documentId: undefined, documentUrl: undefined,
          updatedAt: this.now(),
        });
        await this.deps.store.flush();
        await this.render(task);
      } else { await this.act(task, command.action); }
    });
    return true;
  }

  private async act(task: ProactiveTask, action: string): Promise<CardActionResponse> {
    const prefs = this.deps.store.preferencesFor(task.ownerId);
    if (action !== 'cancel' && !prefs.enabled) return cardFeedback('你已暂停主动助手，请恢复后再操作。', 'warning');
    if (action === 'cancel' && !['accepted', 'cancelled', 'delivered'].includes(task.status)) {
      this.deps.store.updateTask(task.id, { status: 'cancelled', progress: '任务已停止。', question: undefined, error: undefined, updatedAt: this.now() });
      this.workers.get(task.id)?.abort.abort();
    } else if ((action === 'adjust' || action === 'revise') && ['proposed', 'delivered', 'failed'].includes(task.status)) {
      this.deps.store.updateTask(task.id, { status: 'needs_input', question: '请补充希望使用的材料、交付内容或修改要求。', error: undefined, updatedAt: this.now() });
    } else if (action === 'accept' && task.status === 'delivered') {
      this.deps.store.updateTask(task.id, { status: 'accepted', progress: '你已确认验收完成。', updatedAt: this.now() });
      if (task.reviewFollowUpId) this.deps.store.updateFollowUp(task.reviewFollowUpId, { status: 'completed', updatedAt: this.now() });
    } else if (action === 'review' && task.status === 'delivered') {
      const now = this.now();
      if (task.reviewFollowUpId) {
        this.deps.store.updateFollowUp(task.reviewFollowUpId, { status: 'pending', dueAt: now + DAY_MS, nextReminderAt: now + DAY_MS, updatedAt: now,
          reminderAttemptedAt: undefined, reminderSentAt: undefined, overdueReminderCount: 0,
          summary: `检查交付成果：${task.draft?.title ?? task.request.slice(0, 80)} ${task.documentUrl ?? ''}` });
      } else {
        const id = `review_${task.id}_${task.revision}`;
        this.deps.store.createFollowUp({ id, chatId: task.chatId, threadId: task.threadId,
          sourceMessageId: task.cardMessageId ?? task.sourceMessageId, ownerId: task.ownerId, createdById: task.ownerId,
          summary: `检查交付成果：${task.draft?.title ?? task.request.slice(0, 80)} ${task.documentUrl ?? ''}`,
          dueAt: now + DAY_MS, nextReminderAt: now + DAY_MS, status: 'pending', createdAt: now, updatedAt: now,
        });
        this.deps.store.updateTask(task.id, { reviewFollowUpId: id, updatedAt: now });
      }
    } else if ((action === 'start' && task.status === 'proposed') ||
               (action === 'retry' && task.status === 'failed' && !task.publicationAttemptedAt)) {
      if (this.workers.has(task.id)) return cardFeedback('任务正在执行，不会重复启动。');
      if (this.workers.size >= 1) { await this.render(task, '已有主动任务在执行，请稍后点击开始。'); return cardFeedback('已有主动任务在执行，请稍后点击开始。', 'warning'); }
      this.deps.store.updateTask(task.id, { status: 'running', confirmedAt: this.now(), confirmedBy: task.ownerId,
        progress: '正在读取已确认的材料。', question: undefined, error: undefined, updatedAt: this.now() });
      // Durable claim BEFORE any model or external publication. Duplicate clicks see running.
      await this.deps.store.flush();
      await this.render(task);
      const abort = new AbortController();
      const done = this.execute(task, abort).catch(() => {
        log.warn('proactive-task', 'state-persist-failed', { taskId: task.id });
      }).finally(() => this.workers.delete(task.id));
      this.workers.set(task.id, { abort, done });
      return cardFeedback('已开始整理，请查看原卡片进度。', 'success');
    } else return cardFeedback('任务状态已变化，本次没有重复执行。请查看原卡片。');
    await this.deps.store.flush();
    await this.render(task);
    return cardFeedback('操作已完成，请查看原卡片。', 'success');
  }

  private async execute(task: ProactiveTask, abort: AbortController): Promise<void> {
    const timeout = setTimeout(() => abort.abort(new Error('执行超时，请缩小范围后重试。')), this.deps.config.execution!.maxRuntimeMs);
    const enabledWatch = setInterval(() => { if (!this.canAct() || !this.deps.store.preferencesFor(task.ownerId).enabled) abort.abort(); }, 1000);
    let lastProgress = 0;
    try {
      const result = await this.deps.runtime.run(structuredClone(task), abort.signal, async (text) => {
        if (abort.signal.aborted || task.status !== 'running' || this.now() - lastProgress < 4000) return;
        lastProgress = this.now();
        this.deps.store.updateTask(task.id, { progress: text.slice(0, 500), updatedAt: this.now() });
        await this.render(task);
      });
      abort.signal.throwIfAborted();
      if (result.status === 'needs_input') {
        this.deps.store.updateTask(task.id, { status: 'needs_input', question: result.question, progress: undefined, updatedAt: this.now() });
      } else {
        this.deps.store.updateTask(task.id, { status: 'publishing', draft: result.draft,
          progress: '内容已生成，正在创建文档并校验正文和阅读权限。', publicationAttemptedAt: this.now(), updatedAt: this.now() });
        await this.deps.store.flush();
        await this.render(task);
        abort.signal.throwIfAborted();
        const url = await this.deps.runtime.publish(structuredClone(task), abort.signal, async (id, documentUrl) => {
          this.deps.store.updateTask(task.id, { documentId: id, documentUrl, updatedAt: this.now() });
          await this.deps.store.flush();
        });
        abort.signal.throwIfAborted();
        this.deps.store.updateTask(task.id, { status: 'delivered', documentUrl: url, progress: '成果已生成并校验。请打开文档检查，需要调整可继续修改。',
          artifacts: [...task.artifacts, { revision: task.revision, url, title: result.draft.title }], updatedAt: this.now() });
      }
    } catch (error) {
      if (task.status !== 'cancelled') {
        const stopped = abort.signal.aborted;
        this.deps.store.updateTask(task.id, { status: 'failed', progress: undefined,
          error: stopped ? '执行已停止或超时。请稍后重试，或缩小范围后重新确认。' :
            `本次未完成：${safeError(error)}${task.publicationAttemptedAt ? ' 草稿已保存；请调整要求后重新确认交付。' : ''}`,
          updatedAt: this.now() });
      }
      log.warn('proactive-task', 'failed', { taskId: task.id, stage: task.publicationAttemptedAt ? 'publish' : 'run' });
    } finally {
      clearTimeout(timeout); clearInterval(enabledWatch);
      await this.deps.store.flush();
      if (this.canAct()) await this.render(task);
    }
  }

  private render(task: ProactiveTask, transient?: string): Promise<void> {
    const previous = this.cardQueues.get(task.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!this.canAct()) return;
      const card = taskCard(transient ? { ...task, progress: transient } : task);
      try {
        if (task.cardMessageId) {
          // Editing the same card is idempotent, unlike creating a new message.
          for (let attempt = 0; ; attempt++) {
            try { await this.deps.channel.updateCard(task.cardMessageId, card); break; }
            catch (error) { if (attempt >= 2) throw error; await delay(250 * (attempt + 1)); }
          }
        }
        else if (!task.cardAttemptedAt) {
          this.deps.store.updateTask(task.id, { cardAttemptedAt: this.now() });
          await this.deps.store.flush();
          const receipt = await this.deps.channel.send(task.chatId, { card }, { replyTo: task.sourceMessageId, replyInThread: true });
          if (!receipt.messageId) throw new Error('missing card receipt');
          this.deps.store.updateTask(task.id, { cardMessageId: receipt.messageId });
          if (!task.threadId && this.deps.resolveThread) {
            const threadId = await this.deps.resolveThread(receipt.messageId);
            if (threadId) this.deps.store.updateTask(task.id, { threadId });
          }
          await this.deps.store.flush();
        }
      } catch {
        log.warn('proactive-task', 'card-delivery-failed', { taskId: task.id });
      }
    });
    this.cardQueues.set(task.id, next);
    return next;
  }

  private reply(message: ObserverMessage, text: string): Promise<unknown> {
    return this.deps.channel.send(message.chatId, { text }, { replyTo: message.messageId, replyInThread: true });
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async flush(): Promise<void> { await this.queue; await Promise.all(this.cardQueues.values()); await this.deps.store.flush(); }
  async waitForIdle(): Promise<void> { await this.flush(); await Promise.all([...this.workers.values()].map((worker) => worker.done)); }
  async stop(): Promise<void> { for (const worker of this.workers.values()) worker.abort.abort(); await this.waitForIdle(); }
}

export function inferTaskKind(text: string): ProactiveTaskKind | undefined {
  if (/调研|竞品|对比|调查|research|compar(?:e|ison)/i.test(text)) return 'research';
  if (/整理|总结|摘要|汇总|summary|summari[sz]e/i.test(text)) return 'summary';
  if (/起草|初稿|(?:写|生成|制作|做).{0,12}(?:方案|文档|议程|说明|报告|模板|周报)|(?:想要|需要).{0,20}(?:模板|文档|周报)|draft/i.test(text)) return 'draft';
  return undefined;
}
function isTaskCandidate(text: string): boolean {
  return /想要|需要|还没|尚未|帮我|帮忙|给我|能否|可以.*(?:整理|写|调研)|请|求|need|please|help/i.test(text);
}
function isExcludedTask(text: string): boolean {
  return /不用|不需要|不要|已(?:经)?(?:整理|完成)|搞定|取消|只是举例/.test(text) ||
    /部署|删(?:除|掉)|转账|付款|发给客户|群发|修改.{0,8}(?:代码|数据库|生产)/.test(text);
}
function hasExplicitHelpIntent(text: string): boolean { return /帮我|帮忙|给我|我想要|请.{0,12}(?:整理|起草|调研|对比|写|生成|做)|需要.{0,12}(?:调研|整理|起草|模板|文档|周报)/.test(text); }
function taskFingerprint(text: string, kind: ProactiveTaskKind): string {
  return createHash('sha256').update(`${kind}:${text.toLowerCase().replace(/[\s\p{P}]/gu, '')}`).digest('hex');
}
function parseTaskCommand(text: string): { action: string; id?: string; text?: string } | undefined {
  const match = text.trim().match(/^(开始整理|开始执行|开始|重试|暂时不用|取消任务|验收完成|继续修改|调整要求|明天提醒我检查|补充|修改要求)(?:\s+(pt_[a-f0-9]{12}))?\s*[：:]?\s*([\s\S]*)$/);
  if (!match) return undefined;
  const actions: Record<string, string> = { 开始整理: 'start', 开始执行: 'start', 开始: 'start', 重试: 'retry', 暂时不用: 'cancel', 取消任务: 'cancel', 验收完成: 'accept', 继续修改: 'revise', 调整要求: 'adjust', 明天提醒我检查: 'review', 补充: 'supplement', 修改要求: 'supplement' };
  if (match[3] && !['补充', '修改要求'].includes(match[1]!)) return undefined;
  return { action: actions[match[1]!]!, id: match[2], text: match[3]?.trim() };
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return message.replace(/(?:Bearer\s+|(?:token|secret|api[_-]?key)[=:]\s*)\S+/gi, '[已隐藏]').slice(0, 240);
}
