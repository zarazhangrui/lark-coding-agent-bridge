import { formatDueAt } from './due';
import type { FollowUp } from './types';

export const PROACTIVE_CARD_MARKER = '__proactive_follow_up';

type CardAction =
  | 'complete'
  | 'postpone'
  | 'cancel'
  | 'accept'
  | 'confirm-today'
  | 'confirm-tomorrow'
  | 'confirm-next-week';

export function followUpRecordedCard(item: FollowUp, timeZone?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 已记录主动跟进' },
    },
    elements: [
      details(item, '**提醒时间**', timeZone),
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

export function proposalCard(item: FollowUp, assigned: boolean, timeZone?: string): object {
  const dueText = item.dueAt === undefined ? '尚未设置' : formatDueAt(item.dueAt, timeZone);
  const actions = item.dueAt === undefined
    ? [
        button('今天', 'confirm-today', item.id, 'primary'),
        button('明天', 'confirm-tomorrow', item.id),
        button('下周', 'confirm-next-week', item.id),
        button('不跟进', 'cancel', item.id, 'danger'),
      ]
    : [
        button('接受跟进', 'accept', item.id, 'primary'),
        button('明天再提醒', 'confirm-tomorrow', item.id),
        button('不是我的事项', 'cancel', item.id, 'danger'),
      ];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: assigned ? '🙋 待负责人确认' : '🗓️ 需要设置跟进时间',
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**事项**：${escapeMd(item.summary)}\n**当前时间**：${dueText}${
            assigned ? `\n**负责人**：<at id=${item.ownerId}></at>` : ''
          }`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: '请选择一个时间；也可以直接回复“改到明天下午 3 点”。',
        },
      },
      { tag: 'action', actions },
    ],
  };
}

export function reminderCard(item: FollowUp, timeZone?: string, overdue = false): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: overdue ? 'red' : 'orange',
      title: { tag: 'plain_text', content: overdue ? '⚠️ 逾期跟进' : '⏰ 主动跟进提醒' },
    },
    elements: [
      details(item, '**原定时间**', timeZone),
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

export function dashboardCard(
  groups: Array<{ title: string; items: FollowUp[] }>,
  timeZone?: string,
): object {
  const elements: object[] = [];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${group.title}（${group.items.length}）**` },
    });
    for (const item of group.items.slice(0, 10)) {
      const when = item.dueAt === undefined ? '待定时间' : formatDueAt(item.dueAt, timeZone);
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `• ${escapeMd(item.summary)}\n  ${when} · [查看原话题](${sourceUrl(item)})`,
        },
      });
    }
    elements.push({ tag: 'hr' });
  }
  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '目前没有跟进事项。' } });
  } else {
    elements.pop();
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '📋 我的主动跟进' },
    },
    elements,
  };
}

function details(item: FollowUp, dueLabel: string, timeZone?: string): object {
  const due = item.dueAt === undefined ? '待定' : formatDueAt(item.dueAt, timeZone);
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**事项**：${escapeMd(item.summary)}\n${dueLabel}：${due}`,
    },
  };
}

function button(
  text: string,
  action: CardAction,
  followUpId: string,
  style: 'primary' | 'danger' | 'default' = 'default',
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: style,
    value: { [PROACTIVE_CARD_MARKER]: true, action, followUpId },
  };
}

function sourceUrl(item: FollowUp): string {
  if (item.threadId) {
    return `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(item.chatId)}&open_thread_id=${encodeURIComponent(item.threadId)}`;
  }
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(item.chatId)}&openMessageId=${encodeURIComponent(item.sourceMessageId)}`;
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}
