import type { ProactiveTask } from './types';

export const TASK_CARD_MARKER = '__proactive_task';
export const TASK_STATUS_LABELS = {
  proposed: '待确认执行', needs_input: '需要补充信息', running: '执行中',
  publishing: '正在交付', delivered: '已交付，待验收', accepted: '验收完成',
  failed: '执行未完成', cancelled: '已取消',
};
export const TASK_KIND_LABELS = { summary: '资料整理', research: '调研对比', draft: '文档起草' };

export function taskCard(task: ProactiveTask): object {
  const color = task.status === 'failed' ? 'red' :
    task.status === 'delivered' || task.status === 'accepted' ? 'green' : 'blue';
  const actions: object[] = [];
  if (task.status === 'proposed') {
    actions.push(button(task, '开始整理', 'start', true), button(task, '调整要求', 'adjust'), button(task, '暂时不用', 'cancel'));
  } else if (task.status === 'running' || task.status === 'publishing' || task.status === 'needs_input') {
    actions.push(button(task, '取消任务', 'cancel'));
  } else if (task.status === 'delivered') {
    actions.push(button(task, '验收完成', 'accept', true), button(task, '继续修改', 'revise'), button(task, '明天提醒我检查', 'review'));
  } else if (task.status === 'failed') {
    if (!task.publicationAttemptedAt) actions.push(button(task, '重试', 'retry', true));
    actions.push(button(task, '调整要求', 'adjust'), button(task, '取消任务', 'cancel'));
  }
  const detail = task.question ?? task.error ?? task.progress ??
    '确认后生成一份文档；材料来自本话题和你提供的文档。只有需求发起人可以操作。';
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', enable_forward: false },
    header: {
      title: { tag: 'plain_text', content: `主动助手 · ${TASK_STATUS_LABELS[task.status]}` },
      subtitle: { tag: 'plain_text', content: `${TASK_KIND_LABELS[task.kind]} · ${task.id} · 第 ${task.revision} 版` },
      template: color,
    },
    body: {
      direction: 'vertical', padding: '12px', vertical_spacing: '12px',
      elements: [
        { tag: 'column_set', flex_mode: 'none', columns: [{
          tag: 'column', width: 'weighted', weight: 1, background_style: `${color}-50`, padding: '12px',
          elements: [{ tag: 'markdown', content: `**要做的事**\n${escapeCardText(task.request.slice(0, 800))}` }],
        }] },
        { tag: 'markdown', content: escapeCardText(detail.slice(0, 700)) },
        ...(task.documentUrl && ['delivered', 'accepted'].includes(task.status) ? [{
          tag: 'markdown', content: `**[打开交付文档](${task.documentUrl})**${task.reviewReminderAt && task.status === 'delivered' ? '\n已设置成果检查提醒。' : ''}`,
        }] : []),
        ...(task.status === 'needs_input' ? [{ tag: 'markdown', content: `在原话题回复：补充 ${task.id}：你的要求或材料。补充后会再次展示执行范围。`, text_size: 'notation' }] : []),
        ...(actions.length ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
          columns: actions.map((action) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [action] })),
        }] : []),
      ],
    },
  };
}

function button(task: ProactiveTask, label: string, action: string, primary = false): object {
  return {
    tag: 'button', text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: {
      [TASK_CARD_MARKER]: true, taskId: task.id, revision: task.revision, action,
    } }],
  };
}

export function escapeCardText(value: string): string {
  return value.replace(/[&<>*_`\[\]~]/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function taskSourceUrl(task: Pick<ProactiveTask, 'chatId' | 'threadId' | 'sourceMessageId'>): string {
  return task.threadId
    ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(task.chatId)}&open_thread_id=${encodeURIComponent(task.threadId)}`
    : `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(task.chatId)}&openMessageId=${encodeURIComponent(task.sourceMessageId)}`;
}

export function taskNextStep(task: ProactiveTask): string {
  switch (task.status) {
    case 'proposed': return `回复“开始 ${task.id}”确认执行；也可先补充要求。`;
    case 'needs_input': return `回复“补充 ${task.id}：材料或要求”，随后重新确认。`;
    case 'running': case 'publishing': return `正在处理，可回复“取消任务 ${task.id}”停止。`;
    case 'delivered': return `打开成果检查；回复“验收完成 ${task.id}”或“补充 ${task.id}：修改要求”。`;
    case 'failed': return task.publicationAttemptedAt ? '交付结果不确定，已停止自动重建；请联系维护者核对，或补充要求后重新确认。' : `回复“重试 ${task.id}”；重复点击不会重复创建。`;
    case 'accepted': return '已验收，不再催办。';
    case 'cancelled': return '已取消，不会继续执行。';
  }
}

/** Read-only, owner/topic scoped, three entries per page to keep the card compact. */
export function taskOverviewCard(tasks: ProactiveTask[], page: number, now: number, timeZone: string, paused: boolean): object {
  const ordered = [...tasks].sort((a, b) => Number(['accepted', 'cancelled'].includes(a.status)) - Number(['accepted', 'cancelled'].includes(b.status)) || b.updatedAt - a.updatedAt);
  const pages = Math.max(1, Math.ceil(ordered.length / 3));
  const current = Math.min(Math.max(1, page), pages);
  const entries = ordered.slice((current - 1) * 3, current * 3);
  const text = (content: string) => ({ tag: 'markdown', content });
  const block = (content: string, background = 'grey-50') => ({ tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: background, padding: '12px', elements: [text(content)] }] });
  return {
    schema: '2.0', config: { update_multi: true, width_mode: 'default', enable_forward: false },
    header: { title: { tag: 'plain_text', content: '我的主动任务' }, subtitle: { tag: 'plain_text', content: `本话题 · 第 ${current}/${pages} 页 · ${new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit' }).format(now)} 更新` }, template: 'blue' },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements: [
      block(`**${paused ? '已暂停自动执行' : '任务状态与下一步'}**\n仅展示你在本话题发起的任务。${tasks.length ? '' : '目前没有任务；提出文档需求后，助手会先请你确认。'}`, 'blue-50'),
      ...entries.map(task => block(`**${TASK_STATUS_LABELS[task.status]} · ${escapeCardText(task.id)}**\n${escapeCardText(task.request.slice(0, 100))}\n${escapeCardText((task.question ?? task.error ?? task.progress ?? '').slice(0, 180))}\n${task.cardSyncError ? '原任务卡同步失败，以此处状态为准。\n' : ''}${escapeCardText(taskNextStep(task))}\n[查看原话题](${taskSourceUrl(task)})${task.documentUrl && ['delivered', 'accepted'].includes(task.status) ? ` · [打开成果](${task.documentUrl})` : ''}`)),
      text(`回复“我的主动任务”刷新本卡。${pages > 1 ? ` 翻页：我的主动任务 第${current < pages ? current + 1 : 1}页。` : ''}\n若需求未列出，请提供原消息时间以核查接收情况；列表缺失不等于确定没收到。`),
    ] },
  };
}
