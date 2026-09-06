import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  chatIdFromScope,
  listRecoverableMessages,
  MessageRecovery,
} from '../../../src/bot/message-recovery.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('MessageRecovery', () => {
  it('recovers a missed REST message and drops a later duplicate realtime event', async () => {
    const tmp = await temp();
    let now = 1_000_000;
    const delivered: Array<{ id: string; source: string }> = [];
    const missed = message('om_missed', now + 10_000, 'missed');
    const recovery = new MessageRecovery({
      stateFile: join(tmp.profile, 'message-recovery.json'),
      now: () => now,
      settleMs: 0,
      listMessages: async () => [missed],
      deliver: async (item, source) => {
        delivered.push({ id: item.messageId, source });
      },
    });
    await recovery.load();
    await recovery.seedChat('oc_chat', 'p2p');
    now += 20_000;

    await recovery.scanNow();
    await recovery.acceptRealtime(missed);

    expect(delivered).toEqual([{ id: 'om_missed', source: 'recovery' }]);
    const persisted = JSON.parse(
      await readFile(join(tmp.profile, 'message-recovery.json'), 'utf8'),
    ) as { seen: Record<string, number> };
    expect(persisted.seen.om_missed).toBe(now);
  });

  it('does not replay messages that predate a newly seeded checkpoint', async () => {
    const tmp = await temp();
    let now = 2_000_000;
    const seededAt = now;
    const delivered: string[] = [];
    const recovery = new MessageRecovery({
      stateFile: join(tmp.profile, 'message-recovery.json'),
      now: () => now,
      settleMs: 0,
      listMessages: async () => [
        message('om_old', seededAt - 1, 'old'),
        message('om_new', seededAt + 1, 'new'),
      ],
      deliver: async (item) => {
        delivered.push(item.messageId);
      },
    });
    await recovery.seedChat('oc_chat', 'p2p');
    now += 10;

    await recovery.scanNow();

    expect(delivered).toEqual(['om_new']);
  });

  it('retries a message when delivery fails instead of persisting it as seen', async () => {
    const tmp = await temp();
    let now = 3_000_000;
    let attempts = 0;
    const missed = message('om_retry', now + 1, 'retry');
    const recovery = new MessageRecovery({
      stateFile: join(tmp.profile, 'message-recovery.json'),
      now: () => now,
      settleMs: 0,
      intervalMs: 1,
      listMessages: async () => [missed],
      deliver: async () => {
        attempts++;
        if (attempts === 1) throw new Error('temporary intake failure');
      },
    });
    await recovery.seedChat('oc_chat', 'p2p');
    now += 10;

    await recovery.scanNow();
    now += 2;
    await recovery.scanNow();

    expect(attempts).toBe(2);
  });

  it('extracts the chat id from p2p and topic scopes', () => {
    expect(chatIdFromScope('oc_chat')).toBe('oc_chat');
    expect(chatIdFromScope('oc_chat:omt_topic')).toBe('oc_chat');
    expect(chatIdFromScope('comment:file')).toBeUndefined();
  });

  it('lists a bounded chat window and normalizes REST items like live messages', async () => {
    const calls: unknown[] = [];
    const channel = {
      getBotIdentity: () => ({ openId: 'ou_bot', name: 'Bridge' }),
      getChatInfo: async () => ({ chatType: 'p2p' }),
      fetchRawMessage: async () => [],
      rawClient: {
        im: {
          v1: {
            message: {
              list: async (input: unknown) => {
                calls.push(input);
                return {
                  data: {
                    has_more: false,
                    items: [{
                      message_id: 'om_rest',
                      chat_id: 'oc_chat',
                      msg_type: 'text',
                      create_time: '4000001',
                      body: { content: JSON.stringify({ text: 'recovered text' }) },
                      sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
                    }],
                  },
                };
              },
            },
          },
        },
      },
    };

    const result = await listRecoverableMessages(
      channel as never,
      'oc_chat',
      4_000_000,
      4_030_000,
    );

    expect(calls).toEqual([{
      params: expect.objectContaining({
        container_id_type: 'chat',
        container_id: 'oc_chat',
        start_time: '4000',
        end_time: '4030',
        sort_type: 'ByCreateTimeAsc',
      }),
    }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      messageId: 'om_rest',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderId: 'ou_user',
      senderType: 'user',
      content: 'recovered text',
      createTime: 4_000_001,
    });
  });
});

async function temp(): Promise<TmpProfile> {
  const tmp = await createTmpProfile('message-recovery-');
  cleanups.push(tmp.cleanup);
  return tmp;
}

function message(messageId: string, createTime: number, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderType: 'user',
    senderIsBot: false,
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime,
  };
}
