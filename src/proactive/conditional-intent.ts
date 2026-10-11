import type { FollowUp, FollowUpCondition, ObserverMessage } from './types';

/** A bounded, source-grounded feedback request; never generates executable work. */
export function conditionalCandidate(message: ObserverMessage, recent: ObserverMessage[]):
  { ownerId?: string; condition: FollowUpCondition } | undefined {
  const raw = message.text.trim();
  if (raw.length > 1000 || /[“”"「」『』]|举例|例如|比如|假如|假设|如果|不要|不必|不用|无需|别|不需要|还没|尚未/.test(raw)) return;
  // Separate independent clauses before extraction. A trailing permission or
  // tool request must never become part of the confirmed follow-on action.
  const core = raw.split(/(?:[，,]\s*)?(?:顺便|另外|还有|以及)|[。；;\n]/)[0]!
    .replace(/@\S+/g, '').trim().replace(/^(?:行|好的?|可以)[，,\s]+/, '');
  const match = core.match(/^(?:请)?(?:等到?|待|在|一旦)?([^，,！？?]{1,80}?(?:好|完|完成|结束|通过|到位|就绪|回来|收到)(?:了)?)(?:以后|之后|后)?[，,\s]*(?:再|就)?(?:麻烦|请|能否|可以)?((?:告诉我|通知我|告知我|提醒我|教我|跟我说|给我(?:讲|说|说明|反馈)|向我(?:说明|反馈))[^，,！？?]{0,80})[？?！!]?$/);
  if (!match) return;
  const [, prerequisite, nextAction] = match;
  if (!/^(?:请)?(?:等|待|在|一旦)/.test(core) && /好(?:了)?$/.test(prerequisite!) &&
    !/(?:弄|做|搞|迁|准备|配置|设置|办|处理|交接|修|写|建|装|对接|安排).{0,16}好/.test(prerequisite!)) return;
  if (/群主|管理员|权限|密码|密钥|转账|付款|删除|部署|群发|客户|发送|转交|授权|执行|运行|下单|购买/.test(nextAction!)) return;
  const mentions = [...new Map((message.mentions ?? []).map(m => [m.id, m])).values()];
  const owner = mentions.length === 1 ? mentions[0] : undefined;
  // Only a real reply edge supplies the antecedent; recency alone is not a
  // license to attach another conversation's promise to this request.
  const parent = recent.find(m => m.messageId === message.replyToMessageId &&
    m.chatId === message.chatId && m.senderId === owner?.id && m.createTime <= message.createTime);
  return { ownerId: owner?.id, condition: {
    prerequisite: prerequisite!.trim(), nextAction: nextAction!.trim(),
    ownerName: owner?.name, requesterName: message.senderName,
    ...(parent ? { contextMessageId: parent.messageId, contextText: parent.text.slice(0, 250) } : {}),
  } };
}

export function conditionalStage(item: FollowUp): string {
  if (item.status === 'proposed') return '待负责人确认';
  if (item.status === 'completed') return '已完成';
  if (item.status === 'cancelled') return '已取消';
  return item.condition?.satisfiedAt === undefined ? '等待前置事项' : '待后续反馈';
}

export function conditionalNextStep(item: FollowUp): string {
  if (item.status === 'proposed') return `负责人回复“确认跟进 ${item.id}”；不接受可回复“取消跟进 ${item.id}”。`;
  if (item.status !== 'pending') return '已结束，不再跟进。';
  return item.condition?.satisfiedAt === undefined
    ? `前置事项完成后，负责人回复“前置完成 ${item.id}”。`
    : `请向请求人反馈；实际反馈后回复“已反馈 ${item.id}”。`;
}
