import type { DecisionResult, ObserverMessage, ProactiveTask, TaskUpdateKind } from './types';

export const UPDATE_LABELS: Record<TaskUpdateKind, string> = {
  material: '新材料', blocker: '缺资料或受阻', schedule: '时间变化', progress: '进展更新',
};
export const UPDATE_ADVICE: Record<TaskUpdateKind, string> = {
  material: '可采用这些材料，重新确认后整理新一版。',
  blocker: '先补齐缺项；也可补充“先出草稿并标注缺项”后重新确认。',
  schedule: '可把时间变化纳入下一版要求；不会自动修改提醒或约定执行时间。',
  progress: '可把进展纳入下一版；不会仅凭这句话自动验收或开始执行。',
};

export function pendingUpdates(task: ProactiveTask) { return (task.updates ?? []).filter(u => u.status === 'pending'); }
export function updateToken(task: ProactiveTask): string | undefined { return pendingUpdates(task).at(-1)?.message.messageId; }

/** Model output can suggest a kind, never a target, state transition or permission. */
export function detectTaskUpdate(message: ObserverMessage, result?: DecisionResult): TaskUpdateKind | undefined {
  const text = message.text.trim().replace(/^pt_[a-f0-9]{12}\s*[：:]?\s*/, '');
  if (!text || message.mentions?.some(m => m.id !== message.senderId) ||
      /^(?:比如|假如|如果|假设|示例|测试句|引用|转述|等.+后|待.+后)|[“”「」"`]|^>/.test(text) ||
      /(?:别|不要|不用|无需)(?:记录|关联|采用|跟进)|(?:另一个|另外|另起|新建|新的任务)/.test(text)) return;
  // Clear statements only; bare links and dates have no safe default target.
  if (/(?:缺少|还缺|还没拿到|拿不到|卡住了|受阻|还没打通|还没准备好|尚未提供)/.test(text)) return 'blocker';
  if (/(?:截止|交付|演示|提交|完成|会议|验收|时间|日期).{0,12}(?:改到|改为|调整到|推迟到|提前到|延期到)/.test(text)) return 'schedule';
  if (/(?:资料|材料|数据|文档|参考)(?:已到|到了|在这里|如下|已补齐|已经齐了|已准备好|链接[：:])/.test(text)) return 'material';
  if (/^(?:当前|目前|这项任务的)?进展[：:是]|^(?:已经|已)完成了.{2,}/.test(text)) return 'progress';
  const semantic = result?.continuation;
  if (semantic && Number.isFinite(semantic.confidence) && semantic.confidence >= .85 && semantic.kind in UPDATE_LABELS) return semantic.kind;
}

/** Exact owner+topic scope supplied by caller. Never choose the latest of several tasks. */
export function updateCandidates(tasks: ProactiveTask[], message: ObserverMessage): ProactiveTask[] {
  const eligible = tasks.filter(t => t.chatId === message.chatId && t.ownerId === message.senderId &&
    t.threadId === message.threadId && !['accepted', 'cancelled'].includes(t.status) &&
    message.createTime >= t.createdAt && message.messageId !== t.sourceMessageId);
  const ids = message.text.match(/pt_[a-f0-9]{12}/g);
  if (ids?.length) return eligible.filter(t => new Set(ids).size === 1 && t.id === ids[0]);
  if (message.replyToMessageId) {
    const linked = eligible.filter(t => [t.sourceMessageId, t.cardMessageId, ...(t.updates ?? []).map(u => u.message.messageId)].includes(message.replyToMessageId));
    if (linked.length) return linked;
  }
  return message.threadId ? eligible : [];
}

export function updateNextStep(task: ProactiveTask): string | undefined {
  const pending = pendingUpdates(task);
  if (!pending.length || ['accepted', 'cancelled'].includes(task.status)) return;
  const running = ['running', 'publishing'].includes(task.status);
  return `${pending.length} 条动态待确认，尚未改变已确认的要求。${running ? '本次仍按原版本执行；结束后才能采用新材料。' : ''}\n${[...new Set(pending.map(u => UPDATE_ADVICE[u.kind]))].join('\n')}\n回复“采用补充 ${task.id}”或“忽略补充 ${task.id}”；采用后还需单独回复“开始 ${task.id}”。`;
}
