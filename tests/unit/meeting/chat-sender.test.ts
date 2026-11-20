import { describe, expect, it } from 'vitest';
import type { RawActivityItem } from '../../../src/meeting/api';
import { unpackActivity } from '../../../src/meeting/types';

/**
 * The events API puts the chat sender under `operator: { id, user_name }`.
 * Reading only `sender` / `user` / `from` left `from` empty for every real
 * message, so nothing downstream knew who asked.
 */

// A chat_received item in the shape the events API returns (ids and text replaced).
const REAL_CHAT = {
  event_id: 'evt-chat-1',
  meeting: { id: '70001' },
  activity_event_type: 'chat_received',
  chat_received_items: [
    {
      content: '@bot 帮我整理一下刚才的结论',
      message_id: '7000000000000000001',
      message_type: 1,
      operator: { id: 'ou_asker', user_name: '张三', user_role: 0, user_type: 1 },
      send_time: '2026-11-20T15:31:35+08:00',
    },
  ],
} as RawActivityItem;

describe('chat sender (operator)', () => {
  it('reads the sender of a real chat_received item from `operator`', () => {
    expect(unpackActivity(REAL_CHAT)).toEqual([
      {
        kind: 'chat',
        from: { id: 'ou_asker', name: '张三' },
        content: '@bot 帮我整理一下刚才的结论',
        messageType: 1,
      },
    ]);
  });

  it('falls back to operator for a transcript line only when nothing else is there', () => {
    const [a] = unpackActivity({
      activity_event_type: 'transcript_received',
      transcript_received_items: [{ sentence_id: 1, text: 'x', operator: { id: 'ou_o', user_name: '乙' } }],
    } as RawActivityItem);
    expect(a).toMatchObject({ speaker: { id: 'ou_o', name: '乙' } });
    const [b] = unpackActivity({
      activity_event_type: 'transcript_received',
      transcript_received_items: [
        { sentence_id: 1, text: 'x', speaker: { open_id: 'ou_s' }, operator: { id: 'ou_o' } },
      ],
    } as RawActivityItem);
    expect(b).toMatchObject({ speaker: { id: 'ou_s' } });
  });

});
