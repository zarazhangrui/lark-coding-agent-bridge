import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_DEFAULTS, type MeetingConfig } from '../../../src/config/profile-schema';
import { MeetingManager, type MeetingManagerDeps } from '../../../src/meeting/manager';
import type { MeetingSession } from '../../../src/meeting/session';
import { VcApiError, type RawActivityItem, type VcRequestClient } from '../../../src/meeting/api';

/**
 * `dispose()` (every reconnect / restart) keeps the bot in its meetings, so a
 * restarted bridge must re-adopt them — otherwise the bot sits in the meeting
 * deaf: no answers, no summary.
 */

const OLD_ASK = {
  event_id: 'old-ask',
  meeting: { id: '70001' },
  activity_event_type: 'chat_received',
  chat_received_items: [{ content: '@bot 之前的问题', message_type: 1, operator: { id: 'ou_a', user_name: '张三' } }],
} as RawActivityItem;

const OLD_LINE: RawActivityItem = {
  event_id: 'old-line',
  meeting: { id: '70001' },
  activity_event_type: 'transcript_received',
  transcript_received_items: [{ sentence_id: 's1', text: '周五上线', speaker: { open_id: 'ou_b', name: '甲' } }],
};

type EventsReply = { code: number; msg?: string; data?: unknown };

/** join answers per meeting number; `bots/events` answers from `events`. */
function fakeClient(events: (meetingId: string, pageToken?: string) => EventsReply | Promise<EventsReply>) {
  const calls: string[] = [];
  const client: VcRequestClient = {
    request: vi.fn(async (p: { url: string; data?: unknown; params?: Record<string, unknown> }) => {
      calls.push(p.url);
      if (p.url.endsWith('/join')) {
        const no = (p.data as { join_identify: { meeting_no: string } }).join_identify.meeting_no;
        return { code: 0, data: { meeting: { id: `id-${no}`, topic: `会${no}` } } } as never;
      }
      if (p.url.endsWith('/events')) {
        return (await events(String(p.params?.meeting_id ?? ''), p.params?.page_token as string | undefined)) as never;
      }
      return { code: 0, data: {} } as never;
    }),
  };
  return { client, calls };
}

function cfg(): MeetingConfig {
  return { ...MEETING_DEFAULTS, enabled: true, pollIntervalMs: 60_000 };
}

let dir: string;
let stateFile: string;
const read = () => (JSON.parse(readFileSync(stateFile, 'utf8')) as { meetings: { meetingNo: string }[] }).meetings;

function manager(client: VcRequestClient, extra: Partial<MeetingManagerDeps> = {}) {
  const attached: { session: MeetingSession; asks: unknown[] }[] = [];
  const m = new MeetingManager({
    client,
    config: cfg,
    stateFile,
    onSession: (session) => {
      const asks: unknown[] = [];
      session.on('chat', (e) => asks.push(e));
      attached.push({ session, asks });
    },
    ...extra,
  });
  return { m, attached };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meeting-resume-'));
  stateFile = join(dir, 'profile', 'meetings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MeetingManager state file', () => {
  it('records live meetings on join and drops them on ended / leave', async () => {
    const { client } = fakeClient(() => ({ code: 0, data: { events: [] } }));
    const { m } = manager(client);
    await m.join('123456789', { originChatId: 'oc_team' });
    await m.join('987654321');
    expect(read()).toEqual([
      expect.objectContaining({ meetingId: 'id-123456789', meetingNo: '123456789', topic: '会123456789', originChatId: 'oc_team' }),
      expect.objectContaining({ meetingNo: '987654321' }),
    ]);
    m['handleEnded']({ meeting: { id: 'id-987654321' } });
    expect(read().map((r) => r.meetingNo)).toEqual(['123456789']);
    await m.leave('id-123456789');
    expect(read()).toEqual([]);
    m.dispose();
  });

  it('keeps the record across dispose(), which does not leave the meeting', async () => {
    const { client } = fakeClient(() => ({ code: 0, data: { events: [] } }));
    const { m } = manager(client);
    await m.join('123456789');
    m.dispose();
    expect(read().map((r) => r.meetingNo)).toEqual(['123456789']);
  });
});

describe('MeetingManager.resume', () => {
  it('re-adopts a recorded meeting: old events fill the context but are not answered again', async () => {
    const first = manager(fakeClient(() => ({ code: 0, data: { events: [] } })).client);
    await first.m.join('123456789', { originChatId: 'oc_team' });
    first.m.dispose();

    const { client, calls } = fakeClient((_id, token) =>
      !token
        ? { code: 0, data: { events: [OLD_ASK], page_token: 'p1', has_more: true } }
        : token === 'p1'
          ? { code: 0, data: { events: [OLD_LINE], page_token: 'p2', has_more: false } }
          : { code: 0, data: { events: [], page_token: token } },
    );
    const { m, attached } = manager(client);
    await m.resume();

    const s = m.byMeetingNo('123456789');
    expect(s).toBeDefined();
    expect(s!.originChatId).toBe('oc_team');
    expect(s!.resumedAt).toBeTypeOf('number');
    expect(attached).toHaveLength(1);
    expect(attached[0]!.asks).toHaveLength(0);
    expect(s!.recentContext()).toEqual(['张三（弹幕）: @bot 之前的问题', '甲: 周五上线']);
    expect(calls.filter((u) => u.endsWith('/join'))).toHaveLength(0);

    s!.ingest({ ...OLD_ASK, event_id: 'new-ask' });
    expect(attached[0]!.asks).toHaveLength(1);
    m.dispose();
  });

  it('drops a meeting the API refuses (ended while we were down) and reports it', async () => {
    const first = manager(fakeClient(() => ({ code: 0, data: { events: [] } })).client);
    await first.m.join('123456789');
    first.m.dispose();

    const ended: { no: string; err: VcApiError }[] = [];
    const { client } = fakeClient(() => ({ code: 122001, msg: 'meeting status unexpected' }));
    const { m, attached } = manager(client, { onResumeEnded: (r, err) => ended.push({ no: r.meetingNo, err }) });
    await m.resume();

    expect(m.all()).toHaveLength(0);
    expect(attached).toHaveLength(0);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.no).toBe('123456789');
    expect(ended[0]!.err.code).toBe(122001);
    expect(read()).toEqual([]);
  });

  it('keeps the record on a network error and re-adopts on the next start', async () => {
    const first = manager(fakeClient(() => ({ code: 0, data: { events: [] } })).client);
    await first.m.join('123456789');
    first.m.dispose();

    const ended: unknown[] = [];
    const flaky = manager(
      fakeClient(() => {
        throw new Error('ETIMEDOUT');
      }).client,
      { onResumeEnded: (r) => ended.push(r) },
    );
    await flaky.m.resume();
    expect(flaky.m.all()).toHaveLength(0);
    expect(ended).toHaveLength(0);
    expect(read().map((r) => r.meetingNo)).toEqual(['123456789']);
    flaky.m.dispose();

    const next = manager(fakeClient(() => ({ code: 0, data: { events: [] } })).client);
    await next.m.resume();
    expect(next.m.all()).toHaveLength(1);
    next.m.dispose();
  });

  it('treats other API errors (rate limit, token) as transient, not as a finished meeting', async () => {
    const first = manager(fakeClient(() => ({ code: 0, data: { events: [] } })).client);
    await first.m.join('123456789');
    first.m.dispose();

    const ended: unknown[] = [];
    const limited = manager(fakeClient(() => ({ code: 99991400, msg: 'request trigger frequency limit' })).client, {
      onResumeEnded: (r) => ended.push(r),
    });
    await limited.m.resume();
    expect(limited.m.all()).toHaveLength(0);
    expect(ended).toHaveLength(0);
    expect(read().map((r) => r.meetingNo)).toEqual(['123456789']);
    limited.m.dispose();
  });

  it('drops records older than a day without calling the API', async () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({
        meetings: [{ meetingId: 'id-1', meetingNo: '111111111', startedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }],
      }),
    );
    const { client, calls } = fakeClient(() => ({ code: 0, data: { events: [] } }));
    const { m } = manager(client);
    await m.resume();
    expect(m.all()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(read()).toEqual([]);
  });

  it('does not lose records still waiting to be re-adopted when something persists mid-resume', async () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({
        meetings: [
          { meetingId: 'id-111111111', meetingNo: '111111111' },
          { meetingId: 'id-222222222', meetingNo: '222222222' },
        ],
      }),
    );
    let release!: () => void;
    const { client } = fakeClient((id) =>
      id === 'id-111111111'
        ? new Promise<EventsReply>((r) => (release = () => r({ code: 0, data: { events: [] } })))
        : { code: 0, data: { events: [] } },
    );
    const { m } = manager(client);
    const pending = m.resume();
    await new Promise((r) => setTimeout(r, 0));
    await m.join('333333333');
    expect(read().map((r) => r.meetingNo).sort()).toEqual(['111111111', '222222222', '333333333']);
    release();
    await pending;
    expect(m.all()).toHaveLength(3);
    expect(read()).toHaveLength(3);
    m.dispose();
  });

  it('does nothing without a state file, and nothing after dispose', async () => {
    const { client } = fakeClient(() => ({ code: 0, data: { events: [] } }));
    const { m } = manager(client);
    await expect(m.resume()).resolves.toBeUndefined();
    expect(m.all()).toHaveLength(0);

    const first = manager(client);
    await first.m.join('123456789');
    first.m.dispose();
    let release!: () => void;
    const slow = manager(
      fakeClient(() => new Promise<EventsReply>((r) => (release = () => r({ code: 0, data: { events: [] } })))).client,
    );
    const pending = slow.m.resume();
    await new Promise((r) => setTimeout(r, 0));
    slow.m.dispose();
    release();
    await pending;
    expect(slow.m.all()).toHaveLength(0);
    expect(slow.attached).toHaveLength(0);
  });
});

describe('auto-join failure', () => {
  it('reports a failed auto-join after an invite instead of only logging it', async () => {
    const failed: { no: string; err: unknown }[] = [];
    const client: VcRequestClient = {
      request: vi.fn(async () => ({ code: 20017, msg: 'not in gray' }) as never),
    };
    const m = new MeetingManager({
      client,
      config: () => ({ ...cfg(), autoJoinOnInvite: true }),
      onAutoJoinFailed: (no, err) => failed.push({ no, err }),
    });
    m['handleInvited']({ meeting: { meeting_no: '123456789' } });
    await vi.waitFor(() => expect(failed).toHaveLength(1));
    expect(failed[0]!.no).toBe('123456789');
    expect((failed[0]!.err as VcApiError).code).toBe(20017);
  });
});
