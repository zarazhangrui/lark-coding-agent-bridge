import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMessageReplyMode, getRequireMentionInGroup } from '../../../src/config/schema.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import type { NormalizedMessage } from '@larksuite/channel';

describe('Claude IM regression boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps p2p unrestricted while group and topic chats require a direct bot mention by default', () => {
    const cfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
    };

    expect(getRequireMentionInGroup(cfg)).toBe(true);
  });

  it('keeps markdown as the default reply mode and card as the explicit stop-button mode', () => {
    const defaultCfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
    };
    const cardCfg = {
      ...defaultCfg,
      preferences: { messageReply: 'card' as const },
    };

    expect(getMessageReplyMode(defaultCfg)).toBe('markdown');
    expect(getMessageReplyMode(cardCfg)).toBe('card');
  });

  it('queues messages that arrive while a run is active and flushes them as the next batch', () => {
    vi.useFakeTimers();
    const flushed: Array<{ scope: string; batch: NormalizedMessage[] }> = [];
    const queue = new PendingQueue(600, (scope, batch) => flushed.push({ scope, batch }));

    queue.block('chat-1');
    expect(queue.push('chat-1', msg('m-1', 'first'))).toBe(1);
    expect(queue.push('chat-1', msg('m-2', 'second'))).toBe(2);

    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([]);

    queue.unblock('chat-1');
    vi.advanceTimersByTime(599);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([
      { scope: 'chat-1', batch: [msg('m-1', 'first'), msg('m-2', 'second')] },
    ]);
  });

  it('documents the private intake policy that drops @all and undirected group chatter', async () => {
    const source = await readFile(join(process.cwd(), 'src/bot/channel.ts'), 'utf8');

    expect(source).toContain('respondToMentionAll: false');
    expect(source).toContain('getRequireMentionInGroup(controls.cfg)');
    expect(source).toContain('!msg.mentionedBot');
    expect(source).toContain('msg.chatType !== \'p2p\'');
  });
});

function msg(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}
