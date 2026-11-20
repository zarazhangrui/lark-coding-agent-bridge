import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { tryHandleCommand, type CommandContext } from '../../../src/commands/index';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createFakeChannel } from '../../helpers/fake-channel';

/**
 * Forwarding a meeting card in a DM must join through MeetingManager. Handing
 * it to the agent ends with a lark-cli join that bypasses the bridge: the bot
 * is in the meeting but deaf (no answers, no summary).
 */

// Exactly what @larksuite/channel renders for a forwarded video-chat card.
const CARD = '<meeting>\n📹 周会\n🔢 123456789\n🕙 2026-11-20 15:26\n</meeting>';

function harness(opts: { senderId?: string; chatType?: string; enabled?: boolean; manager?: boolean; content?: string } = {}) {
  const channel = createFakeChannel();
  const sessions = new Map<string, { meetingNo: string; topic?: string; ended: boolean }>();
  const join = vi.fn(async (meetingNo: string, o: { originChatId?: string }) => {
    if (meetingNo === '999999999') throw new Error('meeting not found');
    const s = { meetingNo, topic: '周会', ended: false, originChatId: o.originChatId };
    sessions.set(meetingNo, s);
    return s;
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.meeting = { ...profileConfig.meeting, enabled: opts.enabled ?? true };
  const ctx = {
    channel,
    msg: {
      messageId: 'om-1',
      chatId: 'oc-dm',
      chatType: opts.chatType ?? 'p2p',
      senderId: opts.senderId ?? 'ou-owner',
      content: opts.content ?? CARD,
      resources: [],
      mentions: [],
      mentionedBot: false,
    } as unknown as NormalizedMessage,
    scope: 'oc-dm',
    chatMode: 'p2p',
    controls: {
      profile: 'claude',
      profileConfig,
      botOwnerId: 'ou-owner',
      ownerRefreshState: 'ok',
      ...(opts.manager === false
        ? {}
        : { meeting: { join, byMeetingNo: (no: string) => sessions.get(no) } }),
    },
  } as unknown as CommandContext;
  const replies = () =>
    channel.sent.map((m) => String((m.content as { markdown?: string }).markdown ?? ''));
  return { ctx, join, sessions, replies };
}

describe('meeting card forwarded in a DM', () => {
  it('joins through the bridge for the owner, replying like /meeting join', async () => {
    const h = harness();
    await expect(tryHandleCommand(h.ctx)).resolves.toBe(true);
    expect(h.join).toHaveBeenCalledWith('123456789', { originChatId: 'oc-dm' });
    expect(h.replies()[0]).toContain('已入会 **周会**');
  });

  it('works for an admin too', async () => {
    const h = harness({ senderId: 'ou-admin' });
    await tryHandleCommand(h.ctx);
    expect(h.join).toHaveBeenCalledTimes(1);
  });

  it('says "already in" instead of joining twice', async () => {
    const h = harness();
    h.sessions.set('123456789', { meetingNo: '123456789', topic: '周会', ended: false });
    await tryHandleCommand(h.ctx);
    expect(h.join).not.toHaveBeenCalled();
    expect(h.replies()[0]).toContain('已在会中');
  });

  it('reports a failed join', async () => {
    const h = harness({ content: '<meeting>\n🔢 999999999\n</meeting>' });
    await tryHandleCommand(h.ctx);
    expect(h.replies()[0]).toContain('入会失败：meeting not found');
  });

  it('asks for the number when the card has none or several', async () => {
    for (const content of ['<meeting>\n[video chat]\n</meeting>', '<meeting>\n🔢 123456789\n🔢 987654321\n</meeting>']) {
      const h = harness({ content });
      await expect(tryHandleCommand(h.ctx)).resolves.toBe(true);
      expect(h.join).not.toHaveBeenCalled();
      expect(h.replies()[0]).toContain('/meeting join');
    }
  });

  it.each([
    ['a non-admin sender', { senderId: 'ou-stranger' }],
    ['a group chat', { chatType: 'group' }],
    ['meetings disabled', { enabled: false }],
    ['no meeting manager', { manager: false }],
    ['text around the card', { content: `看下这个 ${CARD}` }],
    ['a plain meeting number', { content: '会议号 123456789' }],
  ])('leaves the message to the agent for %s', async (_label, opts) => {
    const h = harness(opts);
    await expect(tryHandleCommand(h.ctx)).resolves.toBe(false);
    expect(h.join).not.toHaveBeenCalled();
    expect(h.replies()).toHaveLength(0);
  });
});
