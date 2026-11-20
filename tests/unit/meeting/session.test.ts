import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEETING_DEFAULTS, type MeetingConfig } from '../../../src/config/profile-schema';
import { MeetingSession } from '../../../src/meeting/session';
import { unpackActivity } from '../../../src/meeting/types';
import { matchTrigger, triggerPrefixes } from '../../../src/meeting/orchestrator';
import type { RawActivityItem, VcRequestClient } from '../../../src/meeting/api';

const noopClient: VcRequestClient = { request: vi.fn(async () => ({ code: 0, data: {} }) as never) };

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return { ...MEETING_DEFAULTS, ...over, transcript: { ...MEETING_DEFAULTS.transcript, ...over.transcript } };
}

function session(config = cfg(), botOpenId = 'ou_bot'): MeetingSession {
  return new MeetingSession({
    client: noopClient,
    meetingId: '70001',
    meetingNo: '123456789',
    config,
    botOpenId,
  });
}

/** One activity item carrying N transcript lines (the real aggregated shape). */
function transcriptItem(
  eventId: string,
  items: { sentence_id: string | number; text: string; speaker?: { open_id?: string; name?: string } }[],
): RawActivityItem {
  return {
    event_id: eventId,
    meeting: { id: '70001' },
    activity_event_type: 'transcript_received',
    transcript_received_items: items,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('unpackActivity (two-layer unpack)', () => {
  it('emits every transcript item in one push, not just the first', () => {
    const events = unpackActivity(
      transcriptItem('e1', [
        { sentence_id: 100001, text: '今天', speaker: { open_id: 'ou_a', name: '甲' } },
        { sentence_id: 100001, text: '今天来讨论', speaker: { open_id: 'ou_a', name: '甲' } },
        { sentence_id: 100002, text: '好的', speaker: { open_id: 'ou_b', name: '乙' } },
      ]),
    );
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.kind === 'transcript' ? e.text : ''))).toEqual([
      '今天',
      '今天来讨论',
      '好的',
    ]);
    expect(events[0]).toMatchObject({ kind: 'transcript', sentenceId: '100001', speaker: { name: '甲' } });
  });

  it('flags the bot own speech as selfEcho', () => {
    const [own, other] = unpackActivity(
      transcriptItem('e1', [
        { sentence_id: 1, text: '我是机器人', speaker: { open_id: 'ou_bot' } },
        { sentence_id: 2, text: '我是人', speaker: { open_id: 'ou_human' } },
      ]),
      'ou_bot',
    );
    expect(own).toMatchObject({ selfEcho: true });
    expect(other).toMatchObject({ selfEcho: false });
  });

  it('normalizes chat, participant and share activities', () => {
    expect(
      unpackActivity({
        event_id: 'c1',
        activity_event_type: 'chat_received',
        chat_received_items: [{ content: '@bot 什么进度', message_type: 1, sender: { name: '甲' } }],
      }),
    ).toEqual([{ kind: 'chat', from: { name: '甲' }, content: '@bot 什么进度', messageType: 1 }]);

    expect(
      unpackActivity({
        event_id: 'p1',
        activity_event_type: 'participant_left',
        participant_left_items: [{ user: { open_id: 'ou_a', name: '甲' }, leave_reason: 'hangup' }],
      }),
    ).toEqual([{ kind: 'participant', action: 'left', user: { id: 'ou_a', name: '甲' }, leaveReason: 'hangup' }]);

    expect(
      unpackActivity({
        event_id: 's1',
        activity_event_type: 'magic_share_started',
        magic_share_started_items: [{ url: 'https://x/doc', title: '设计稿' }],
      }),
    ).toEqual([{ kind: 'share', action: 'started', url: 'https://x/doc', title: '设计稿' }]);
  });

  it('ignores unknown activity types and missing arrays', () => {
    expect(unpackActivity({ event_id: 'x', activity_event_type: 'future_type' })).toEqual([]);
    expect(unpackActivity({ event_id: 'x', activity_event_type: 'transcript_received' })).toEqual([]);
    expect(unpackActivity({})).toEqual([]);
  });
});

describe('MeetingSession ingest pipeline', () => {
  it('de-duplicates by event_id so replayed pushes land once', () => {
    const s = session();
    const seen: string[] = [];
    s.on('transcript', (e) => seen.push(e.kind === 'transcript' ? e.text : ''));

    const item = transcriptItem('e1', [{ sentence_id: 1, text: '一', speaker: { name: '甲' } }]);
    s.ingest(item);
    s.ingest(item); // same event_id — poll/push overlap

    expect(seen).toEqual(['一']);
    expect(s.status().ingested).toBe(1);
  });

  it('keeps one buffered line per sentence as it grows, and drops exact repeats', () => {
    const s = session();
    const emitted: string[] = [];
    s.on('transcript', (e) => emitted.push(e.kind === 'transcript' ? e.text : ''));

    s.ingest(transcriptItem('e1', [{ sentence_id: 7, text: '今天', speaker: { name: '甲' } }]));
    s.ingest(transcriptItem('e2', [{ sentence_id: 7, text: '今天来讨论', speaker: { name: '甲' } }]));
    s.ingest(transcriptItem('e3', [{ sentence_id: 7, text: '今天来讨论', speaker: { name: '甲' } }]));

    // Every change is emitted (stabilizeMs = 0), but the repeat is dropped.
    expect(emitted).toEqual(['今天', '今天来讨论']);
    // The buffer holds the latest version once, not each prefix.
    expect(s.recentTranscript()).toEqual(['甲: 今天来讨论']);
    expect(s.status().transcriptLines).toBe(1);
  });

  it('filters the bot own transcribed speech out of the buffer', () => {
    const s = session();
    s.ingest(
      transcriptItem('e1', [
        { sentence_id: 1, text: '机器人说的', speaker: { open_id: 'ou_bot', name: 'Bot' } },
        { sentence_id: 2, text: '人说的', speaker: { open_id: 'ou_human', name: '甲' } },
      ]),
    );
    expect(s.recentTranscript()).toEqual(['甲: 人说的']);
  });

  it('honours stabilizeMs: only the settled sentence is emitted', () => {
    vi.useFakeTimers();
    const s = session(cfg({ transcript: { keep: 200, stabilizeMs: 800 } }));
    const emitted: string[] = [];
    s.on('transcript', (e) => emitted.push(e.kind === 'transcript' ? e.text : ''));

    s.ingest(transcriptItem('e1', [{ sentence_id: 9, text: '今天', speaker: { name: '甲' } }]));
    vi.advanceTimersByTime(500);
    s.ingest(transcriptItem('e2', [{ sentence_id: 9, text: '今天来讨论', speaker: { name: '甲' } }]));
    expect(emitted).toEqual([]); // still growing

    vi.advanceTimersByTime(800);
    expect(emitted).toEqual(['今天来讨论']); // settled once, final text only
  });

  it('caps the rolling buffer at transcript.keep', () => {
    const s = session(cfg({ transcript: { keep: 3, stabilizeMs: 0 } }));
    for (let i = 1; i <= 5; i++) {
      s.ingest(transcriptItem(`e${i}`, [{ sentence_id: i, text: `第${i}句`, speaker: { name: '甲' } }]));
    }
    expect(s.recentTranscript()).toEqual(['甲: 第3句', '甲: 第4句', '甲: 第5句']);
  });

  it('tracks participants and exposes them in status', () => {
    const s = session();
    s.ingest({
      event_id: 'p1',
      activity_event_type: 'participant_joined',
      participant_joined_items: [{ user: { open_id: 'ou_a' } }, { user: { open_id: 'ou_b' } }],
    });
    expect(s.status().participants).toBe(2);
    s.ingest({
      event_id: 'p2',
      activity_event_type: 'participant_left',
      participant_left_items: [{ user: { open_id: 'ou_a' } }],
    });
    expect(s.status().participants).toBe(1);
  });

  it('stops ingesting once the meeting ended, and leave() is idempotent', async () => {
    const client: VcRequestClient = { request: vi.fn(async () => ({ code: 0, data: {} }) as never) };
    const s = new MeetingSession({
      client,
      meetingId: '70001',
      meetingNo: '123456789',
      config: cfg(),
    });

    await s.leave();
    await s.leave(); // second call must not re-hit the API
    expect(client.request).toHaveBeenCalledTimes(1);

    s.ingest(transcriptItem('e1', [{ sentence_id: 1, text: '晚了', speaker: { name: '甲' } }]));
    expect(s.recentTranscript()).toEqual([]);
  });

  it('tallies each activity type, flagging ones it could not parse', () => {
    const s = session();

    // Handled + parseable.
    s.ingest(transcriptItem('e1', [{ sentence_id: 1, text: '一', speaker: { name: '甲' } }]));
    // Right type, but the items array is missing -> nothing extracted.
    s.ingest({ event_id: 'e2', activity_event_type: 'transcript_received' });
    // A type this build doesn't know about at all.
    s.ingest({ event_id: 'e3', activity_event_type: 'some_future_type', some_future_items: [{}] });

    // `?`-prefixed keys make a silent zero visible: here transcripts DID arrive
    // once and failed once, which is very different from never arriving.
    expect(s.status().eventCounts).toEqual({
      transcript_received: 1,
      '?transcript_received': 1,
      '?some_future_type': 1,
    });
  });

  it('reads items nested under payload (structured shape) as well as flat', () => {
    const s = session();
    s.ingest({
      event_id: 'p1',
      event_type: 'transcript_received',
      payload: { transcript_received_items: [{ sentence_id: 5, text: '嵌套的', speaker: { name: '乙' } }] },
    } as never);
    expect(s.recentTranscript()).toEqual(['乙: 嵌套的']);
  });

  it('reports the event source, flipping to push when a push arrives', () => {
    const s = session();
    expect(s.status().source).toBe('poll');
    s.markPushActive();
    expect(s.status().source).toBe('push');
  });

  it('de-duplicates a duplicate delivery that carries no event_id', () => {
    const s = session();
    const seen: string[] = [];
    s.on('chat', (e) => seen.push(e.kind === 'chat' ? e.content : ''));

    // Same chat message arriving over push and over poll, with no event_id on
    // either. Firing twice would start a second agent run that then gets
    // rejected as "another run is already active".
    const item = {
      activity_event_type: 'chat_received',
      chat_received_items: [
        { content: '@bot 在吗', message_type: 1, create_time: '1700000000', sender: { open_id: 'ou_a' } },
      ],
    };
    s.ingest({ ...item });
    s.ingest({ ...item });

    expect(seen).toEqual(['@bot 在吗']);
  });

  it('still treats genuinely different messages as distinct without event_id', () => {
    const s = session();
    const seen: string[] = [];
    s.on('chat', (e) => seen.push(e.kind === 'chat' ? e.content : ''));

    s.ingest({
      activity_event_type: 'chat_received',
      chat_received_items: [{ content: '第一句', create_time: '1' }],
    });
    s.ingest({
      activity_event_type: 'chat_received',
      chat_received_items: [{ content: '第二句', create_time: '2' }],
    });

    expect(seen).toEqual(['第一句', '第二句']);
  });

  it('stops polling once push takes over, so events stop arriving twice', () => {
    const s = session();
    s.startPolling();
    // Handing over is the point: both lanes carry the same content.
    s.markPushActive();
    expect(s.status().source).toBe('push');
    // Idempotent — a second push must not re-enter the handover.
    s.markPushActive();
    expect(s.status().source).toBe('push');
  });
});

describe('in-meeting trigger matching', () => {
  it('accepts @<botName> as well as the configured prefix', () => {
    const prefixes = triggerPrefixes('@bot', '助手');
    expect(prefixes).toEqual(['@bot', '@助手']);

    expect(matchTrigger('@助手 在吗', prefixes)).toBe('在吗');
    expect(matchTrigger('@bot 在吗', prefixes)).toBe('在吗');
  });

  it('drops punctuation right after the prefix', () => {
    const prefixes = triggerPrefixes('@bot', '助手');
    expect(matchTrigger('@助手，刚才说到哪了', prefixes)).toBe('刚才说到哪了');
    expect(matchTrigger('@助手: 总结一下', prefixes)).toBe('总结一下');
    expect(matchTrigger('@助手，，  在吗', prefixes)).toBe('在吗');
  });

  it('distinguishes "not for me" from "for me but empty"', () => {
    const prefixes = triggerPrefixes('@bot', '助手');
    // undefined = not addressed to the bot at all
    expect(matchTrigger('大家好', prefixes)).toBeUndefined();
    expect(matchTrigger('@别人 在吗', prefixes)).toBeUndefined();
    // '' = addressed, but nothing was asked
    expect(matchTrigger('@助手', prefixes)).toBe('');
    expect(matchTrigger('@助手 ', prefixes)).toBe('');
  });

  it('accepts the mention mid- or end-of-sentence', () => {
    const prefixes = triggerPrefixes('@bot', '羽木的三儿');
    // the real chat that went unanswered in the T0049 field test
    expect(matchTrigger('说句话听听@羽木的三儿', prefixes)).toBe('说句话听听');
    expect(matchTrigger('刚才说到哪了 @bot', prefixes)).toBe('刚才说到哪了');
    expect(matchTrigger('谢谢 @bot.', prefixes)).toBe('谢谢 .');
    expect(matchTrigger('请 @羽木的三儿 总结一下', prefixes)).toBe('请 总结一下');
    expect(matchTrigger('喂@羽木的三儿', prefixes)).toBe('喂');
    // not glued to latin words / emails / domains
    expect(matchTrigger('发到 a@bot.com 了', prefixes)).toBeUndefined();
    expect(matchTrigger('看看 @bot.com 这个', prefixes)).toBeUndefined();
    expect(matchTrigger('看看 @bottle 这个', prefixes)).toBeUndefined();
    expect(matchTrigger('问一下 @别人', prefixes)).toBeUndefined();
  });

  it('matches latin bot names case-insensitively', () => {
    const prefixes = triggerPrefixes('@bot', 'Nemo');
    expect(matchTrigger('@nemo hello', prefixes)).toBe('hello');
    expect(matchTrigger('@NEMO hello', prefixes)).toBe('hello');
  });

  it('de-duplicates when the configured prefix already is the bot name', () => {
    expect(triggerPrefixes('@助手', '助手')).toEqual(['@助手']);
    // No bot name yet (before connect) → only the configured prefix.
    expect(triggerPrefixes('@bot', undefined)).toEqual(['@bot']);
  });
});
