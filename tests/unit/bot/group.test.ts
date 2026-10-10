import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { createBoundChat, defaultChatName } from '../../../src/bot/group.js';

describe('group chat helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the current agent display name in generated chat names', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 25, 16, 52, 0));

    expect(defaultChatName('Codex')).toBe('Codex · 5-25 16:52');
  });

  it('passes the description through to channel.createChat', async () => {
    const createChat = vi.fn().mockResolvedValue({ chatId: 'oc_test' });
    const channel = { createChat } as unknown as LarkChannel;

    await createBoundChat({
      channel,
      name: 'Claude Code · 5-25 16:52',
      inviteOpenId: 'ou_user',
      description: 'Claude Code session group',
    });

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Claude Code session group' }),
    );
  });

  it('omits the description when not configured', async () => {
    const createChat = vi.fn().mockResolvedValue({ chatId: 'oc_test' });
    const channel = { createChat } as unknown as LarkChannel;

    await createBoundChat({
      channel,
      name: 'Claude Code · 5-25 16:52',
      inviteOpenId: 'ou_user',
    });

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ description: undefined }),
    );
  });
});
