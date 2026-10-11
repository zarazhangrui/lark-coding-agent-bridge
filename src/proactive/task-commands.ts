import type { ProactiveTask } from './types';

export type TaskAction = 'start' | 'retry' | 'cancel' | 'accept' | 'revise' | 'adjust' | 'review' | 'supplement' | 'adopt' | 'dismiss';
export interface TaskCommand { action: TaskAction; id?: string; text?: string; contextual?: boolean }

/** Only whole-message intent is accepted. Generic agreement is never execution consent. */
export function parseTaskCommand(input: string): TaskCommand | undefined {
  const text = input.trim().replace(/[。！!]+$/, '').trim();
  const update = text.match(/^(采用补充|忽略补充)(?:\s+(pt_[a-f0-9]{12}))?$/);
  if (update) return { action: update[1] === '采用补充' ? 'adopt' : 'dismiss', id: update[2] };
  const explicit = text.match(/^(开始整理|开始执行|开始|重试|暂时不用|取消任务|验收完成|继续修改|调整要求|明天提醒我检查|补充|修改要求)(?:\s+(pt_[a-f0-9]{12}))?\s*[：:]?\s*([\s\S]*)$/);
  if (explicit) {
    const actions: Record<string, TaskAction> = { 开始整理: 'start', 开始执行: 'start', 开始: 'start', 重试: 'retry', 暂时不用: 'cancel', 取消任务: 'cancel', 验收完成: 'accept', 继续修改: 'revise', 调整要求: 'adjust', 明天提醒我检查: 'review', 补充: 'supplement', 修改要求: 'supplement' };
    const action = actions[explicit[1]!]!;
    if (!explicit[3] || action === 'supplement') return { action, id: explicit[2], text: explicit[3]?.trim() };
  }
  if (/^(?:开始(?:整理|执行)?吧|可以开始了|就按这个来|整理)$/.test(text)) return { action: 'start', contextual: true };
  if (/^(?:这个|这项|这个任务)?(?:已完成|完成了|做好了|验收通过)$/.test(text)) return { action: 'accept', contextual: true };
  if (/^(?:这个|这项|这个任务)?(?:取消吧|先取消|先不做了|不用做了)$/.test(text)) return { action: 'cancel', contextual: true };
  if (/^(?:改到明天(?:吧)?|明天再(?:看|提醒我|检查)(?:吧)?)$/.test(text)) return { action: 'review', contextual: true };
  if (/^(?:精简一点|再短一点|改成.{1,}|改为.{1,}|调整为.{1,}|增加.{1,}|补充一下[：:].{1,})/.test(text)) {
    return { action: 'supplement', text, contextual: true };
  }
  return undefined;
}

export function taskAcceptsAction(task: ProactiveTask, action: TaskAction, explicitId = false): boolean {
  switch (action) {
    case 'adopt': case 'dismiss': return !['accepted', 'cancelled'].includes(task.status) && !!task.updates?.some(u => u.status === 'pending');
    case 'start': return task.status === 'proposed';
    case 'retry': return task.status === 'failed' && !task.publicationAttemptedAt;
    case 'accept': case 'review': return task.status === 'delivered';
    case 'cancel': return ['proposed', 'needs_input', 'running', 'publishing', 'failed'].includes(task.status);
    case 'adjust': case 'revise': return ['proposed', 'delivered', 'failed'].includes(task.status);
    case 'supplement': return ['proposed', 'needs_input', 'delivered', 'failed'].includes(task.status) || (explicitId && task.status === 'accepted');
  }
}
