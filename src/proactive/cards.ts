import { formatDueAt } from './due';
import type { FollowUp } from './types';

export const PROACTIVE_CARD_MARKER = '__proactive_follow_up';

export function followUpRecordedCard(item: FollowUp, timeZone?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 已记录主动跟进' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**事项**：${escapeMd(item.summary)}\n**提醒时间**：${formatDueAt(item.dueAt, timeZone)}`,
        },
      },
      {
        tag: 'action',
        actions: [
          button('已完成', 'complete', item.id, 'primary'),
          button('取消跟进', 'cancel', item.id, 'danger'),
        ],
      },
    ],
  };
}

export function reminderCard(item: FollowUp, timeZone?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '⏰ 主动跟进提醒' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**事项**：${escapeMd(item.summary)}\n**原定时间**：${formatDueAt(item.dueAt, timeZone)}`,
        },
      },
      {
        tag: 'action',
        actions: [
          button('已完成', 'complete', item.id, 'primary'),
          button('明天再提醒', 'postpone', item.id),
          button('取消跟进', 'cancel', item.id, 'danger'),
        ],
      },
    ],
  };
}

function button(
  text: string,
  action: 'complete' | 'postpone' | 'cancel',
  followUpId: string,
  style: 'primary' | 'danger' | 'default' = 'default',
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: style,
    value: {
      [PROACTIVE_CARD_MARKER]: true,
      action,
      followUpId,
    },
  };
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

