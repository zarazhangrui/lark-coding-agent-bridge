import { describe, expect, it } from 'vitest';
import { detectTaskUpdate, updateCandidates } from '../../../src/proactive/task-continuity';
import type { ObserverMessage, ProactiveTask } from '../../../src/proactive/types';

const msg = (text: string): ObserverMessage => ({ messageId: 'new', chatId: 'chat', threadId: 'topic', senderId: 'owner', text, createTime: 10 });
const task: ProactiveTask = { id: 'pt_aaaaaaaaaaaa', chatId: 'chat', threadId: 'topic', ownerId: 'owner', sourceMessageId: 'source',
  kind: 'draft', request: '起草验收方案', fingerprint: 'f', revision: 1, context: [], artifacts: [], status: 'proposed', createdAt: 1, updatedAt: 1 };

describe('bounded continuity interpretation', () => {
  it.each(['收到', '明天天气不错', 'https://example.com', '比如资料在这里：正文', '如果资料到了就好了',
    '“资料在这里”是什么意思', '不要关联，资料在这里：正文', '另外资料在这里：新任务正文',
    '> 资料在这里', '等资料到了后告诉我'])('does not stage unrelated, hypothetical or negated text: %s', text => {
    expect(detectTaskUpdate(msg(text))).toBeUndefined();
  });
  it('does not treat another person’s mention as a task-owner update', () => {
    expect(detectTaskUpdate({ ...msg('资料在这里：正文'), mentions: [{ id: 'other' }] })).toBeUndefined();
  });
  it('requires a high-confidence structured classification for nonliteral wording', () => {
    const m = msg('这份说明得缓缓，上游数据还在核实');
    expect(detectTaskUpdate(m, { action: 'ignore', confidence: 1, continuation: { kind: 'blocker', confidence: .84 } })).toBeUndefined();
    expect(detectTaskUpdate(m, { action: 'ignore', confidence: 1, continuation: { kind: 'blocker', confidence: .95 } })).toBe('blocker');
    expect(detectTaskUpdate(m, { action: 'ignore', confidence: 1, continuation: { kind: 'blocker', confidence: NaN } })).toBeUndefined();
  });
  it('requires explicit binding outside a topic and rejects unknown or multiple IDs', () => {
    const top = { ...task, threadId: undefined };
    expect(updateCandidates([top], { ...msg('资料在这里：正文'), threadId: undefined })).toEqual([]);
    expect(updateCandidates([top], { ...msg(`${task.id} 资料在这里：正文`), threadId: undefined })).toEqual([top]);
    expect(updateCandidates([task], msg('pt_bbbbbbbbbbbb 资料在这里：正文'))).toEqual([]);
    expect(updateCandidates([task], msg(`${task.id} pt_bbbbbbbbbbbb 资料在这里：正文`))).toEqual([]);
  });
});
