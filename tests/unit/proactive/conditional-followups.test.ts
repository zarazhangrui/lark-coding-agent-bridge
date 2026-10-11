import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { ProactiveController } from '../../../src/proactive/controller';
import { ProactiveStore } from '../../../src/proactive/store';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';
import { createFakeChannel } from '../../helpers/fake-channel';
import { CONDITIONAL_CARD_MARKER } from '../../../src/proactive/conditional-cards';
import { PROACTIVE_CARD_MARKER } from '../../../src/proactive/cards';
import { conditionalStage } from '../../../src/proactive/conditional-intent';

const NOW = Date.parse('2026-10-11T13:00:00Z');
function msg(id: string, content: string, senderId = 'requester'): NormalizedMessage {
  return { messageId: id, chatId: 'chat', chatType: 'group', threadId: 'topic', senderId,
    content, rawContentType: 'text', resources: [], mentions: [], mentionAll: false,
    mentionedBot: false, createTime: NOW };
}
async function harness(mode: 'active' | 'shadow' = 'active') {
  const dir = await mkdtemp(join(tmpdir(), 'conditional-followups-'));
  const path = join(dir, 'state.json'); const store = new ProactiveStore(path);
  const channel = createFakeChannel(); const updateCard = vi.fn(async () => {});
  const config = normalizeProfileConfig({ schemaVersion: 2, agentKind: 'claude', accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } }, proactiveObserver: { enabled: true, mode, allowedChats: ['chat'], conditionalFollowUps: true } }).proactiveObserver;
  const decide = vi.fn(async () => ({ action: 'clarify' as const, confidence: .42 }));
  const controller = new ProactiveController({ config, store, channel: { send: channel.send, updateCard } as never, decisionProvider: { decide }, now: () => NOW });
  await controller.load();
  const send = async (m: NormalizedMessage) => { controller.enqueue(m); await controller.flush(); };
  const propose = async () => {
    await send(msg('parent', '我把企业微信的表格迁过来', 'owner'));
    await send({ ...msg('request', '@_user_1 行，弄好了告诉我该怎么做，顺便codex能把群主都直接给我吗？'),
      replyToMessageId: 'parent', mentions: [{ key: '@_user_1', openId: 'owner', name: '同事', isBot: false }] });
    return store.snapshot().followUps[0]!;
  };
  return { controller, store, path, config, decide, channel, updateCard, send, propose };
}

describe('conditional collaboration through the observer', () => {
  it('captures the real low-score request as a proposal without bundling permissions or inventing time', async () => {
    const h = await harness(); const item = await h.propose();
    expect(item).toMatchObject({ status: 'proposed', ownerId: 'owner', createdById: 'requester',
      condition: { prerequisite: '弄好了', nextAction: '告诉我该怎么做', contextMessageId: 'parent' } });
    expect(item.dueAt).toBeUndefined(); expect(item.confirmedAt).toBeUndefined();
    expect(item.summary).not.toContain('群主');
    expect(h.store.snapshot().tasks).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]!.options).toMatchObject({ replyTo: 'request', replyInThread: true });
    expect(JSON.stringify(h.channel.sent[0]!.content)).toContain('待负责人确认');
    await h.controller.runDueReminders(); expect(h.channel.sent).toHaveLength(1);
    await h.controller.stop();
  });

  it('requires the owner and separates confirmation, prerequisite satisfaction and final feedback', async () => {
    const h = await harness(); const item = await h.propose();
    await h.send(msg('not-owner', `确认跟进 ${item.id}`));
    expect(h.store.getFollowUp(item.id)!.status).toBe('proposed');
    await h.send(msg('owner-confirm', `确认跟进 ${item.id}`, 'owner'));
    expect(h.store.getFollowUp(item.id)).toMatchObject({ status: 'pending', confirmedAt: NOW });
    await h.send(msg('too-vague', '这个完成了', 'owner'));
    expect(h.store.getFollowUp(item.id)!.status).toBe('pending');
    await h.send(msg('condition-met', `前置完成 ${item.id}`, 'owner'));
    expect(h.store.getFollowUp(item.id)).toMatchObject({ status: 'pending', condition: { satisfiedAt: NOW } });
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('待后续反馈');
    await h.send(msg('final', `已反馈 ${item.id}`, 'owner'));
    expect(h.store.getFollowUp(item.id)!.status).toBe('completed');
    const reloaded = new ProactiveStore(h.path); await reloaded.load();
    expect(reloaded.getFollowUp(item.id)!.status).toBe('completed');
    await h.controller.stop();
  });

  it('leaves Shadow read-only', async () => {
    const h = await harness('shadow'); await h.propose();
    expect(h.store.snapshot().followUps).toHaveLength(0); expect(h.channel.sent).toHaveLength(0);
    await h.controller.stop();
  });

  it.each(['owner', 'chat', 'card', 'stage', 'feature-off', 'paused', 'shadow'] as const)('blocks invalid button operation: %s', async guard => {
    const h = await harness(); const item = await h.propose();
    const payload = { [CONDITIONAL_CARD_MARKER]: true, followUpId: item.id, stage: guard === 'stage' ? 'waiting' : conditionalStage(item), action: 'confirm' };
    if (guard === 'feature-off') h.config.conditionalFollowUps = false;
    if (guard === 'shadow') h.config.mode = 'shadow';
    if (guard === 'paused') h.store.updatePreferences('owner', { enabled: false });
    await h.controller.handleCardAction(payload, guard === 'chat' ? 'other' : 'chat', guard === 'owner' ? 'requester' : 'owner', guard === 'card' ? 'forged' : item.receiptMessageId!);
    expect(h.store.getFollowUp(item.id)!.status).toBe('proposed');
    await h.controller.stop();
  });

  it('returns an authoritative card, rejects stale clicks, and survives restart while waiting', async () => {
    const h = await harness(); const item = await h.propose();
    const payload = { [CONDITIONAL_CARD_MARKER]: true, followUpId: item.id, stage: conditionalStage(item), action: 'confirm' };
    const result = await h.controller.handleCardAction(payload, 'chat', 'owner', item.receiptMessageId!);
    expect(JSON.stringify(result)).toContain('等待前置事项');
    await h.controller.handleCardAction({ ...payload, action: 'ready' }, 'chat', 'owner', item.receiptMessageId!);
    expect(h.store.getFollowUp(item.id)!.condition!.satisfiedAt).toBeUndefined();
    const second = new ProactiveStore(h.path); await second.load();
    expect(second.getFollowUp(item.id)!.status).toBe('pending');
    expect(second.dueFollowUps(NOW + 365 * 86400_000)).toHaveLength(0);
    await h.controller.handleCardAction({ [PROACTIVE_CARD_MARKER]: true, followUpId: item.id, action: 'complete' }, 'chat', 'owner', item.receiptMessageId!);
    expect(h.store.getFollowUp(item.id)!.status).toBe('pending');
    await h.controller.stop();
  });

  it('does not let text escape topic or confirmation-time boundaries', async () => {
    const h = await harness(); const item = await h.propose();
    await h.send({ ...msg('cross', `确认跟进 ${item.id}`, 'owner'), threadId: 'other' });
    await h.send({ ...msg('stale', `确认跟进 ${item.id}`, 'owner'), createTime: NOW - 1 });
    await h.send(msg('early-complete', `已反馈 ${item.id}`, 'owner'));
    expect(h.store.getFollowUp(item.id)!.status).toBe('proposed');
    expect(h.store.getFollowUp(item.id)!.condition!.satisfiedAt).toBeUndefined();
    await h.controller.stop();
  });

  it('deduplicates repeat requests and exposes items to the owner and requester only', async () => {
    const h = await harness(); await h.propose();
    await h.send({ ...msg('repeat', '@_user_1 行，弄好了告诉我该怎么做，顺便codex能把群主都直接给我吗？'), replyToMessageId: 'parent',
      mentions: [{ key: '@_user_1', openId: 'owner', isBot: false }] });
    expect(h.store.snapshot().followUps).toHaveLength(1); expect(h.channel.sent).toHaveLength(1);
    await h.send(msg('list-owner', '我的协作跟进', 'owner'));
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('待负责人确认');
    await h.send(msg('list-requester', '我的协作跟进'));
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('待负责人确认');
    await h.send(msg('list-other', '我的协作跟进', 'unrelated'));
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).not.toContain('fu_');
    await h.controller.stop();
  });

  it('records a failed card patch without rolling back the confirmed business state', async () => {
    const h = await harness(); const item = await h.propose(); h.updateCard.mockRejectedValue(new Error('platform failure'));
    await h.send(msg('confirm', `确认跟进 ${item.id}`, 'owner'));
    expect(h.store.getFollowUp(item.id)).toMatchObject({ status: 'pending', condition: { cardSyncError: true } });
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('原卡同步失败');
    await h.controller.stop();
  });

  it('does not assign responsibility to an unmentioned person', async () => {
    const h = await harness(); await h.send(msg('unknown', '等表格迁好后告诉我怎么用'));
    expect(h.store.snapshot().followUps).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('负责人不明确');
    await h.controller.stop();
  });

  it('falls back to the grounded proposal when the judge is unavailable', async () => {
    const h = await harness(); h.decide.mockRejectedValue(new Error('offline')); await h.propose();
    expect(h.store.snapshot().followUps[0]!.status).toBe('proposed');
    expect(h.store.snapshot().decisions.at(-1)).toMatchObject({ outcome: 'applied', reason: 'conditional-proposal' });
    await h.controller.stop();
  });

  it.each(['requester', 'owner'])('honors %s pause before proposing', async userId => {
    const h = await harness(); h.store.updatePreferences(userId, { enabled: false }); await h.propose();
    expect(h.store.snapshot().followUps).toHaveLength(0); expect(h.channel.sent).toHaveLength(0);
    await h.controller.stop();
  });

  it('bounds daily proposals without lowering any thresholds', async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) await h.send({ ...msg(`req-${i}`, `@_user_1 等材料${i}准备好后告诉我怎么操作`),
      mentions: [{ key: '@_user_1', openId: 'owner', isBot: false }] });
    expect(h.store.snapshot().followUps).toHaveLength(3);
    expect(h.store.snapshot().decisions.at(-1)).toMatchObject({ outcome: 'ignored', reason: 'conditional-proposal-limit' });
    expect(h.config.shadowThreshold).toBe(.6); expect(h.config.actionThreshold).toBe(.85);
    await h.controller.stop();
  });

  it('keeps the feature opt-in and honors owner quiet hours', async () => {
    const h = await harness(); h.config.conditionalFollowUps = false; await h.propose();
    expect(h.store.snapshot().followUps).toHaveLength(0);
    h.config.conditionalFollowUps = true; h.store.updatePreferences('owner', { quietHours: { start: '20:00', end: '23:00' } });
    await h.send({ ...msg('quiet', '@_user_1 等资料准备好后告诉我'), mentions: [{ key: '@_user_1', openId: 'owner', isBot: false }] });
    expect(h.store.snapshot().followUps).toHaveLength(0);
    await h.controller.stop();
  });
});
