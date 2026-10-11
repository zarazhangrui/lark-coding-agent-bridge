import { describe, expect, it } from 'vitest';
import { conditionalCandidate } from '../../../src/proactive/conditional-intent';
import type { ObserverMessage } from '../../../src/proactive/types';

const message = (text: string): ObserverMessage => ({ messageId: 'request', chatId: 'chat',
  senderId: 'requester', text, createTime: 10, mentions: [{ id: 'owner', name: '同事' }] });

describe('bounded conditional feedback extraction', () => {
  it.each([
    ['@同事 弄好了告诉我该怎么做', '弄好了', '告诉我该怎么做'],
    ['@同事 等表格迁好后，再告诉我怎么用', '表格迁好', '告诉我怎么用'],
    ['@同事 待审核通过之后通知我', '审核通过', '通知我'],
    ['@同事 材料准备好了，教我操作流程', '材料准备好了', '教我操作流程'],
    ['@同事 一旦资料到位就给我说明下一步', '资料到位', '给我说明下一步'],
    ['@同事 在会议结束以后，麻烦给我反馈结论', '会议结束', '给我反馈结论'],
  ])('extracts %s without fabricating facts', (text, prerequisite, nextAction) => {
    expect(conditionalCandidate(message(text), [])).toMatchObject({ ownerId: 'owner', condition: { prerequisite, nextAction } });
  });
  it.each([
    '@同事 今天天气很好，告诉我你怎么看',
    '@同事 不用等表格迁好后再告诉我',
    '@同事 等表格迁好后不用通知我',
    '@同事 如果失败了就告诉我',
    '@同事 比如“弄好了告诉我”就是个请求',
    '@同事 等表格迁好后，告诉我管理员密码',
    '@同事 等审批通过后，转账给我',
    '@同事 等材料到位后，告诉我密码并删除日志',
    '@同事 告诉我表格什么时候能弄好',
  ])('does not propose quoted/negated/speculative or unsafe action: %s', text => {
    expect(conditionalCandidate(message(text), [])).toBeUndefined();
  });
  it('separates an independent permission request instead of authorizing it', () => {
    const result = conditionalCandidate(message('@同事 弄好了告诉我怎么操作，顺便把群主给我'), []);
    expect(result!.condition.nextAction).toBe('告诉我怎么操作');
  });
  it('requires exactly one explicit recipient, not a model-invented person', () => {
    expect(conditionalCandidate({ ...message('弄好了告诉我'), mentions: [] }, [])!.ownerId).toBeUndefined();
    expect(conditionalCandidate({ ...message('弄好了告诉我'), mentions: [{ id: 'a' }, { id: 'b' }] }, [])!.ownerId).toBeUndefined();
  });
  it('uses only a direct same-chat reply to the assignee as antecedent', () => {
    const parent = { ...message('我来迁移表格'), messageId: 'p', senderId: 'owner', createTime: 1 };
    const m = { ...message('弄好了告诉我'), replyToMessageId: 'p' };
    expect(conditionalCandidate(m, [parent])!.condition.contextMessageId).toBe('p');
    expect(conditionalCandidate({ ...m, replyToMessageId: undefined }, [parent])!.condition.contextMessageId).toBeUndefined();
    expect(conditionalCandidate(m, [{ ...parent, chatId: 'other' }])!.condition.contextMessageId).toBeUndefined();
    expect(conditionalCandidate(m, [{ ...parent, senderId: 'other' }])!.condition.contextMessageId).toBeUndefined();
    expect(conditionalCandidate(m, [{ ...parent, createTime: 20 }])!.condition.contextMessageId).toBeUndefined();
  });
});
