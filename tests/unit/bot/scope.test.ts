import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { ChatModeCache, type ChatMode } from '../../../src/bot/chat-mode-cache.js';
import { isThreadedScope, scopeFor, scopeForMessage } from '../../../src/bot/scope.js';

/** Minimal fake channel that only implements getChatMode, counting calls. */
function fakeChannel(mode: ChatMode): {
  channel: LarkChannel;
  getChatMode: ReturnType<typeof vi.fn>;
} {
  const getChatMode = vi.fn(async () => mode);
  return { channel: { getChatMode } as unknown as LarkChannel, getChatMode };
}

function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_sender',
    content: 'hi',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...overrides,
  };
}

describe('isThreadedScope', () => {
  it('is true only when a thread_id is present', () => {
    expect(isThreadedScope('omt_abc')).toBe(true);
    expect(isThreadedScope(undefined)).toBe(false);
    expect(isThreadedScope('')).toBe(false);
  });
});

describe('scopeFor', () => {
  it('isolates a "convert to topic" thread inside a plain group', async () => {
    const { channel } = fakeChannel('group');
    const scope = await scopeFor(channel, 'oc_chat', 'omt_abc', new ChatModeCache());
    expect(scope).toBe('oc_chat:omt_abc');
  });

  it('shares the chat session for a quote-reply (no thread_id) in a plain group', async () => {
    const { channel } = fakeChannel('group');
    const scope = await scopeFor(channel, 'oc_chat', undefined, new ChatModeCache());
    expect(scope).toBe('oc_chat');
  });

  it('shares the chat session for an ordinary plain-group message', async () => {
    const { channel } = fakeChannel('group');
    const scope = await scopeFor(channel, 'oc_chat', undefined, new ChatModeCache());
    expect(scope).toBe('oc_chat');
  });

  it('keeps topic-group topics isolated (regression)', async () => {
    const { channel } = fakeChannel('topic');
    const scope = await scopeFor(channel, 'oc_chat', 'omt_xyz', new ChatModeCache());
    expect(scope).toBe('oc_chat:omt_xyz');
  });

  it('uses chatId for p2p chats', async () => {
    const { channel } = fakeChannel('p2p');
    const scope = await scopeFor(channel, 'oc_dm', undefined, new ChatModeCache());
    expect(scope).toBe('oc_dm');
  });

  it('warms the chat-mode cache once per chat (one API call)', async () => {
    const { channel, getChatMode } = fakeChannel('group');
    const cache = new ChatModeCache();
    await scopeFor(channel, 'oc_chat', undefined, cache);
    await scopeFor(channel, 'oc_chat', 'omt_abc', cache);
    expect(getChatMode).toHaveBeenCalledTimes(1);
  });
});

describe('scopeForMessage', () => {
  it('derives scope from the message chatId/threadId', async () => {
    const { channel } = fakeChannel('group');
    const cache = new ChatModeCache();
    expect(await scopeForMessage(channel, msg({ threadId: 'omt_abc' }), cache)).toBe(
      'oc_chat:omt_abc',
    );
    expect(await scopeForMessage(channel, msg({}), cache)).toBe('oc_chat');
  });
});
