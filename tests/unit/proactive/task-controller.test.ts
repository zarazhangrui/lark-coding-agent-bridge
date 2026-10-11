import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProactiveObserverConfig } from '../../../src/config/profile-schema';
import type { LarkChannel } from '@larksuite/channel';
import { RunRejected } from '../../../src/runtime/errors';
import { ProactiveTaskController, type TaskRuntime } from '../../../src/proactive/task-controller';
import { taskCard, TASK_CARD_MARKER } from '../../../src/proactive/task-cards';
import { ProactiveStore } from '../../../src/proactive/store';
import type { ObserverMessage } from '../../../src/proactive/types';

const now = Date.parse('2026-10-11T08:00:00Z');
const config: ProactiveObserverConfig = {
  enabled: true, mode: 'active', timeZone: 'Asia/Shanghai', allowedChats: ['chat'],
  actionThreshold: .85, lowRiskActionThreshold: .6, shadowThreshold: .6,
  contextMessages: 20, contextWindowHours: 24, pollIntervalMs: 60_000,
  dueSoonMinutes: 60, overdueReminderIntervalMinutes: 1440, overdueReminderMaxCount: 2, defaultDailyReminderLimit: 5,
  execution: { enabled: true, maxRuntimeMs: 30_000, dailyProposalLimit: 3, proposalCooldownMinutes: 0 },
};
const draft = { title: '试点方案', content: '这是根据话题中提供的材料整理的一份完整方案，包含目的、实施步骤和检查标准。', sources: [] };
function message(text = '请帮我起草一份实习群试点方案', overrides: Partial<ObserverMessage> = {}): ObserverMessage {
  return { messageId: 'source', chatId: 'chat', threadId: 'thread', senderId: 'owner', text, createTime: now, ...overrides };
}
async function harness(options: { active?: boolean; enabled?: boolean; runtime?: Partial<TaskRuntime> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-task-'));
  const store = new ProactiveStore(join(dir, 'state.json'));
  const channel = { send: vi.fn<LarkChannel['send']>(async () => ({ messageId: 'card' })), updateCard: vi.fn(async () => undefined) };
  const run = vi.fn<TaskRuntime['run']>(options.runtime?.run ?? (async () => ({ status: 'ready', draft })));
  const publish = vi.fn<TaskRuntime['publish']>(options.runtime?.publish ?? (async (_t, _s, created) => {
    await created('doc123', 'https://www.feishu.cn/docx/doc123');
    return 'https://www.feishu.cn/docx/doc123';
  }));
  const cfg = structuredClone(config);
  cfg.execution!.enabled = options.enabled ?? true;
  let active = options.active ?? true;
  const controller = new ProactiveTaskController({ config: cfg, store, channel, runtime: { run, publish },
    now: () => now, canAct: () => active, resolveThread: async () => 'created-thread' });
  const offer = (m = message()) => controller.offer(m, { action: 'possible-complex-task', confidence: .8 });
  const task = () => store.snapshot().tasks[0]!;
  const click = (action: string, overrides: Record<string, unknown> = {}, owner = 'owner', chat = 'chat', card = 'card') =>
    controller.handleCard({ [TASK_CARD_MARKER]: true, taskId: task().id, revision: task().revision, action, ...overrides }, chat, owner, card);
  return { controller, store, channel, run, publish, offer, task, click, cfg, dir, setActive: (v: boolean) => { active = v; } };
}

describe('confirmed proactive execution', () => {
  it('does not intercept a reminder-only completion or commands from another topic/owner', async () => {
    const h = await harness(); await h.offer();
    expect(await h.controller.handleMessage(message('这个完成了'))).toBe(false);
    expect(await h.controller.handleMessage(message('开始吧', { senderId: 'other' }))).toBe(false);
    expect(await h.controller.handleMessage(message('开始吧', { threadId: 'other' }))).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('does not use an old recovered approval to start a newer revision', async () => {
    const h = await harness(); await h.offer();
    h.store.updateTask(h.task().id, { revision: 2, approvalRequestedAt: now + 1000 });
    await h.controller.handleMessage(message(`开始 ${h.task().id}`));
    expect(h.run).not.toHaveBeenCalled(); expect(h.task().status).toBe('proposed');
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('早于');
  });

  it('requires an explicit task id to revise an accepted artifact and preserves its history', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle(); await h.click('accept');
    expect(await h.controller.handleMessage(message('精简一点'))).toBe(false);
    await h.controller.handleMessage(message(`补充 ${h.task().id}：精简一点`));
    expect(h.task()).toMatchObject({ status: 'proposed', revision: 2, confirmedAt: undefined, documentUrl: undefined });
    expect(h.task().artifacts).toHaveLength(1); expect(h.publish).toHaveBeenCalledOnce();
  });

  it('shows a busy explanation without claiming another task is queued', async () => {
    const h = await harness({ runtime: { run: async (_task, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'needs_input', question: '停止' }), { once: true })) } });
    await h.offer(); await h.click('start');
    const second = { ...h.task(), id: 'pt_aaaaaaaaaaaa', status: 'proposed' as const, kind: 'research' as const };
    h.store.createTask(second);
    await h.controller.handleMessage(message(`开始 ${second.id}`));
    expect(h.store.getTask(second.id)).toMatchObject({ status: 'proposed', progress: expect.stringContaining('未排队') });
    expect(h.run).toHaveBeenCalledOnce(); await h.controller.stop();
  });

  it('explains executor pool rejection in Chinese', async () => {
    const h = await harness({ runtime: { run: async () => { throw new RunRejected('pool-full', 'pool full'); } } });
    await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(h.task()).toMatchObject({ status: 'failed', error: expect.stringContaining('执行资源正忙') });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('persists card synchronization failures and exposes them on the overview', async () => {
    const h = await harness(); await h.offer();
    h.channel.updateCard.mockRejectedValue(new Error('permission denied'));
    await h.click('adjust'); expect(h.task().cardSyncError).toContain('同步失败');
    await h.controller.handleMessage(message('我的主动任务'));
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('原任务卡同步失败');
    h.channel.updateCard.mockResolvedValue(undefined);
    await h.controller.handleMessage(message(`补充 ${h.task().id}：请给新人阅读`));
    expect(h.task().cardSyncError).toBeUndefined();
  });

  it('does not duplicate an overview after an ambiguous initial send', async () => {
    const h = await harness(); await h.offer();
    h.channel.send.mockRejectedValueOnce(new Error('network timeout'));
    await h.controller.handleMessage(message('我的主动任务'));
    const cards = () => h.channel.send.mock.calls.filter(c => 'card' in c[1]);
    expect(cards()).toHaveLength(2);
    await h.controller.handleMessage(message('我的主动任务'));
    expect(cards()).toHaveLength(2); expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('未新建卡片');
  });

  it('paginates overview and synchronizes its existing card after a state transition', async () => {
    const h = await harness(); await h.offer();
    for (let i = 1; i <= 4; i++) h.store.createTask({ ...h.task(), id: `pt_${String(i).padStart(12, '0')}`, request: `任务${i}`, updatedAt: now - i });
    await h.controller.handleMessage(message('我的主动任务 第2页'));
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('第 2/2 页');
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('任务4');
    await h.controller.handleMessage(message('我的主动任务 第1页'));
    await h.click('adjust');
    expect(JSON.stringify(h.channel.updateCard.mock.lastCall)).toContain('需要补充信息');
    expect(h.store.snapshot().taskDashboards).toHaveLength(1);
  });
  it.each(['开始吧', '开始整理吧！', '整理', '可以开始了'])('starts the only applicable proposal via %s, not an older delivered task', async (text) => {
    const h = await harness(); await h.offer();
    h.store.createTask({ ...h.task(), id: 'pt_aaaaaaaaaaaa', status: 'delivered', kind: 'research' });
    await h.controller.handleMessage(message(text)); await h.controller.waitForIdle();
    expect(h.run).toHaveBeenCalledTimes(1); expect(h.task().status).toBe('delivered');
    expect(h.channel.send.mock.calls.some((c) => JSON.stringify(c).includes('已开始'))).toBe(true);
  });

  it.each(['好', '行', '可以', '不要开始', '他说开始吧', '开始吧然后帮我删文件'])('does not infer task approval from %s', async (text) => {
    const h = await harness(); await h.offer();
    expect(await h.controller.handleMessage(message(text))).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('lists choices instead of guessing between two startable proposals', async () => {
    const h = await harness(); await h.offer();
    h.store.createTask({ ...h.task(), id: 'pt_aaaaaaaaaaaa', kind: 'research' });
    await h.controller.handleMessage(message('开始吧'));
    expect(h.run).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('pt_aaaaaaaaaaaa');
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('有多个');
  });

  it('does not steal a vague completion when a reminder is also open', async () => {
    const h = await harness(); await h.offer(); h.store.updateTask(h.task().id, { status: 'delivered' });
    h.store.createFollowUp({ id: 'fu_open', chatId: 'chat', threadId: 'thread', ownerId: 'owner', sourceMessageId: 'f', summary: '开会', status: 'pending', dueAt: now + 1, createdAt: now, updatedAt: now });
    expect(await h.controller.handleMessage(message('这个完成了'))).toBe(true);
    expect(h.task().status).toBe('delivered'); expect(h.store.getFollowUp('fu_open')?.status).toBe('pending');
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('提醒');
  });

  it('accepts a unique delivered task and replies in the same topic', async () => {
    const h = await harness(); await h.offer(); h.store.updateTask(h.task().id, { status: 'delivered' });
    await h.controller.handleMessage(message('这个完成了'));
    expect(h.task().status).toBe('accepted');
    expect(h.channel.send).toHaveBeenLastCalledWith('chat', { text: expect.stringContaining('验收完成') }, { replyTo: 'source', replyInThread: true });
  });

  it('turns a natural revision into a new unconfirmed version', async () => {
    const h = await harness(); await h.offer(); h.store.updateTask(h.task().id, { status: 'delivered', confirmedAt: now });
    await h.controller.handleMessage(message('精简一点，把问题放前面'));
    expect(h.task()).toMatchObject({ status: 'proposed', revision: 2, confirmedAt: undefined });
    expect(h.task().request).toContain('精简一点，把问题放前面'); expect(h.run).not.toHaveBeenCalled();
  });

  it('keeps paused text operations visible but read-only', async () => {
    const h = await harness(); await h.offer(); h.store.updatePreferences('owner', { enabled: false });
    await h.controller.handleMessage(message('开始吧'));
    expect(h.task().status).toBe('proposed'); expect(h.run).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.send.mock.lastCall)).toContain('暂停');
  });

  it('refreshes one persistent overview card, scoped to owner/topic and without running work', async () => {
    const h = await harness(); await h.offer();
    h.store.createTask({ ...h.task(), id: 'foreign', ownerId: 'other', request: 'PRIVATE' });
    await h.controller.handleMessage(message('我的主动任务'));
    const first = JSON.stringify(h.channel.send.mock.lastCall);
    expect(first).toContain('我的主动任务'); expect(first).toContain('待确认'); expect(first).not.toContain('PRIVATE');
    expect(first).toContain('open_thread_id');
    const count = h.channel.send.mock.calls.filter(c => 'card' in c[1]).length;
    await h.controller.handleMessage(message('任务进度'));
    expect(h.channel.send.mock.calls.filter(c => 'card' in c[1])).toHaveLength(count);
    const reloaded = new ProactiveStore(join(h.dir, 'state.json')); await reloaded.load();
    expect(reloaded.snapshot().taskDashboards).toHaveLength(1);
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each([
    '我想要份实习生周报模板，包含本周完成的工作、遇到的问题、下周计划三个部分，每部分给一个填写示例，生成飞书文档。',
    '给我做个周报模板',
    'I would like a weekly report template',
  ])('proposes natural document requests without requiring magic words: %s', async (text) => {
    const h = await harness();
    expect(await h.controller.offer(message(text), { action: 'possible-complex-task', confidence: .9, taskKind: 'draft' })).toBe(true);
    expect(h.task()).toMatchObject({ kind: 'draft', status: 'proposed' });
    expect(h.run).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
  });

  it('recognizes an explicit document request if the judge is unavailable', async () => {
    const h = await harness();
    expect(await h.controller.offer(message('我想要份实习生周报模板，生成飞书文档。'), { action: 'ignore', confidence: 0 })).toBe(true);
    expect(h.task().status).toBe('proposed'); expect(h.run).not.toHaveBeenCalled();
  });

  it('does not use a task kind attached to a non-task decision as permission to propose', async () => {
    const h = await harness();
    await h.controller.offer(message('周报模板挺好看'), { action: 'ignore', confidence: .99, taskKind: 'draft' });
    expect(h.store.snapshot().tasks).toHaveLength(0);
  });

  it.each(['不用生成周报模板', '帮我修改生产代码，生成说明文档', '请群发这份文档'])('retains safety exclusions even for a structured task decision: %s', async (text) => {
    const h = await harness();
    await h.controller.offer(message(text), { action: 'possible-complex-task', confidence: .99, taskKind: 'draft' });
    expect(h.store.snapshot().tasks).toHaveLength(0);
  });

  it('only proposes before confirmation and updates one topic card through verified delivery', async () => {
    const h = await harness();
    await h.offer();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.task().status).toBe('proposed');
    expect(h.channel.send).toHaveBeenCalledWith('chat', expect.anything(), { replyTo: 'source', replyInThread: true });
    expect(await h.click('start')).toMatchObject({ toast: { type: 'success', content: '已开始整理，请查看原卡片进度。' } });
    await h.controller.waitForIdle();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.task()).toMatchObject({ status: 'delivered', confirmedBy: 'owner', documentId: 'doc123', artifacts: [{ revision: 1 }] });
    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(h.channel.updateCard).toHaveBeenCalled();
  });

  it.each(['owner', 'chat', 'card', 'revision'])('rejects mismatched %s and repeated confirmations', async (bad) => {
    const h = await harness(); await h.offer();
    expect(await h.click('start', bad === 'revision' ? { revision: 0 } : {}, bad === 'owner' ? 'other' : 'owner', bad === 'chat' ? 'other' : 'chat', bad === 'card' ? 'other' : 'card')).toMatchObject({ toast: { type: 'warning' } });
    expect(h.run).not.toHaveBeenCalled();
    await Promise.all([h.click('start'), h.click('start'), h.click('start')]);
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });

  it.each([{ active: false }, { enabled: false }])('does not send or execute when disabled/shadow', async (mode) => {
    const h = await harness(mode); await h.offer();
    expect(h.channel.send).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });

  it.each(['shadow', 'disabled', 'paused', 'removed-chat'])('explains a blocked click after a proposal: %s', async (reason) => {
    const h = await harness(); await h.offer();
    if (reason === 'shadow') h.setActive(false);
    if (reason === 'disabled') h.cfg.execution!.enabled = false;
    if (reason === 'paused') h.store.updatePreferences('owner', { enabled: false });
    if (reason === 'removed-chat') h.cfg.allowedChats = [];
    expect(await h.click('start')).toMatchObject({ toast: { type: 'warning' } });
    expect(h.task().status).toBe('proposed'); expect(h.run).not.toHaveBeenCalled();
    expect(h.channel.send).toHaveBeenCalledTimes(1);
  });

  it('explains a repeated start after delivery without republishing', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(await h.click('start')).toMatchObject({ toast: { type: 'info', content: expect.stringContaining('没有重复执行') } });
    expect(h.run).toHaveBeenCalledTimes(1); expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('returns the committed card view on acceptance and repairs an authorized stale click', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    for (let i = 0; i < 2; i++) {
      const response = await h.click('accept');
      expect(response).toMatchObject({ card: { type: 'raw', data: { header: { title: { content: '主动助手 · 验收完成' } } } } });
      expect(response && JSON.stringify(response.card)).not.toContain('继续修改');
      expect(h.task().status).toBe('accepted');
    }
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects other chats, ordinary chatter, negations and operational mutations', async () => {
    const h = await harness();
    await h.offer(message(undefined, { chatId: 'other' }));
    for (const text of ['已经完成整理', '今天讨论方案', '不用帮我调研', '帮我修改代码并写方案', '请帮我部署方案']) await h.offer(message(text));
    expect(h.store.snapshot().tasks).toHaveLength(0);
  });

  it('deduplicates repeated requests and limits proposals per user', async () => {
    const h = await harness(); h.cfg.execution!.dailyProposalLimit = 1;
    await h.offer(); await h.offer(message(undefined, { messageId: 'duplicate' }));
    await h.click('cancel');
    await h.offer(message('请帮我调研新的协作工具', { messageId: 'second' }));
    expect(h.channel.send).toHaveBeenCalledTimes(3);
    expect(h.store.snapshot().tasks).toHaveLength(1);
  });

  it('does not suggest during quiet hours or when paused by the owner', async () => {
    const h = await harness(); h.store.updatePreferences('owner', { quietHours: { start: '15:00', end: '17:00' } });
    await h.offer(); expect(h.channel.send).not.toHaveBeenCalled();
    h.store.updatePreferences('owner', { quietHours: undefined, enabled: false });
    await h.offer(); expect(h.channel.send).not.toHaveBeenCalled();
  });

  it('requires a new confirmation after missing information or revisions', async () => {
    const h = await harness({ runtime: { run: async () => ({ status: 'needs_input', question: '请提供目标读者。' }) } });
    await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(h.task().status).toBe('needs_input'); expect(h.publish).not.toHaveBeenCalled();
    await h.controller.handleMessage(message(`补充 ${h.task().id}：目标读者为实习生`));
    expect(h.task()).toMatchObject({ status: 'proposed', revision: 2, confirmedAt: undefined });
    await h.click('start', { revision: 1 }); expect(h.run).toHaveBeenCalledTimes(1);
    await h.click('start'); await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('isolates natural-language commands by owner and topic', async () => {
    const h = await harness(); await h.offer();
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { senderId: 'other' }));
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { threadId: 'other' }));
    expect(h.run).not.toHaveBeenCalled();
    await h.controller.handleMessage(message(`开始 ${h.task().id}`));
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('cancels running work without publishing its late result', async () => {
    let finish!: (value: Awaited<ReturnType<TaskRuntime['run']>>) => void;
    const h = await harness({ runtime: { run: (_task, signal) => new Promise((resolve) => {
      finish = resolve;
      signal.addEventListener('abort', () => resolve({ status: 'ready', draft }), { once: true });
    }) } });
    await h.offer(); await h.click('start'); await h.click('cancel'); finish({ status: 'ready', draft });
    await h.controller.waitForIdle(); expect(h.task().status).toBe('cancelled'); expect(h.publish).not.toHaveBeenCalled();
  });

  it('records an ambiguous publish failure and never automatically retries creation', async () => {
    const h = await harness({ runtime: { publish: async (_task, _signal, created) => {
      await created('partial', 'https://www.feishu.cn/docx/partial'); throw new Error('权限不足');
    } } });
    await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    expect(h.task()).toMatchObject({ status: 'failed', documentId: 'partial' });
    await h.click('retry'); await h.controller.waitForIdle();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(taskCard(h.task()))).not.toContain('打开交付文档');
  });

  it.each(['running', 'publishing'] as const)('marks interrupted %s after restart without replay', async (status) => {
    const h = await harness(); await h.offer(); h.store.updateTask(h.task().id, { status });
    await h.controller.recover(); await h.controller.recover();
    expect(h.task().status).toBe('failed'); expect(h.run).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
  });

  it('creates one review reminder and accepts the delivered artifact', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle();
    await h.click('review'); await h.click('review');
    expect(h.store.snapshot().followUps).toHaveLength(1);
    await h.click('accept'); expect(h.task().status).toBe('accepted');
    expect(h.store.snapshot().followUps[0]!.status).toBe('completed');
  });

  it('reuses the review reminder after a new revision', async () => {
    const h = await harness(); await h.offer(); await h.click('start'); await h.controller.waitForIdle(); await h.click('review');
    await h.controller.handleMessage(message(`补充 ${h.task().id}：新增验收标准`));
    expect(h.store.snapshot().followUps[0]!.status).toBe('cancelled');
    await h.click('start'); await h.controller.waitForIdle(); await h.click('review');
    expect(h.store.snapshot().followUps).toHaveLength(1); expect(h.store.snapshot().followUps[0]!.status).toBe('pending');
    expect(h.task().artifacts).toHaveLength(2);
  });

  it('records the topic created by the proposal for later text commands', async () => {
    const h = await harness(); await h.offer(message(undefined, { threadId: undefined }));
    expect(h.task().threadId).toBe('created-thread');
    await h.controller.handleMessage(message(`开始 ${h.task().id}`, { threadId: 'created-thread' }));
    await h.controller.waitForIdle(); expect(h.run).toHaveBeenCalledTimes(1);
  });
});
