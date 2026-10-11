import type { ProactiveTask } from './types';

export const TASK_CARD_MARKER = '__proactive_task';
const LABELS = {
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
      title: { tag: 'plain_text', content: `主动助手 · ${LABELS[task.status]}` },
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
          tag: 'markdown', content: `**[打开交付文档](${task.documentUrl})**${task.reviewFollowUpId ? '\n已设置明天的验收提醒。' : ''}`,
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
