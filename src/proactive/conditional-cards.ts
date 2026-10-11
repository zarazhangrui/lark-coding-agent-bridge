import { conditionalNextStep, conditionalStage } from './conditional-intent';
import { escapeCardText, taskSourceUrl } from './task-cards';
import type { FollowUp } from './types';

export const CONDITIONAL_CARD_MARKER = '__proactive_conditional';

export function conditionalCard(item: FollowUp): object {
  const c = item.condition!;
  const stage = conditionalStage(item);
  const action = item.status === 'proposed' ? ['确认跟进', 'confirm'] :
    item.status === 'pending' ? c.satisfiedAt === undefined ? ['前置事项已完成', 'ready'] : ['已向对方反馈', 'complete'] : undefined;
  const button = (label: string, command: string, primary = false) => ({
    tag: 'button', text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { [CONDITIONAL_CARD_MARKER]: true,
      followUpId: item.id, stage, action: command } }],
  });
  const green = item.status === 'completed';
  return {
    schema: '2.0', config: { update_multi: true, width_mode: 'default', enable_forward: false },
    header: { title: { tag: 'plain_text', content: `协作跟进 · ${stage}` },
      subtitle: { tag: 'plain_text', content: item.id }, template: green ? 'green' : 'blue' },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements: [
      { tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1,
        background_style: green ? 'green-50' : 'blue-50', padding: '12px', elements: [
          { tag: 'markdown', content: `**先等什么**\n${escapeCardText(c.prerequisite)}\n\n**之后要做什么**\n${escapeCardText(c.nextAction)}` },
        ] }] },
      { tag: 'markdown', content: `拟负责人：${escapeCardText(c.ownerName ?? item.ownerId)}\n请求人：${escapeCardText(c.requesterName ?? item.createdById ?? '')}${c.contextText ? `\n引用背景：${escapeCardText(c.contextText)}` : ''}` },
      { tag: 'markdown', content: `${escapeCardText(conditionalNextStep(item))}\n不设置虚构日期、不自动执行操作；其他权限变更等诉求不在本事项内。${c.cardSyncError ? '\n原卡同步失败，请查询最新台账。' : ''}\n[查看来源](${taskSourceUrl(item)})`, text_size: 'notation' },
      ...(action ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: [
        button(action[0]!, action[1]!, true), button('不再跟进', 'cancel'),
      ].map(b => ({ tag: 'column', width: 'weighted', weight: 1, elements: [b] })) }] : []),
    ] },
  };
}
