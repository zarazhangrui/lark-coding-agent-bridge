import { describe, expect, it, vi } from 'vitest';
import { MEETING_DEFAULTS, type MeetingConfig } from '../../../src/config/profile-schema';
import { MeetingManager, VC_BOT_EVENTS, describeMeetingError } from '../../../src/meeting/manager';
import { VcApiError, type VcRequestClient } from '../../../src/meeting/api';

type Handler = (data: unknown) => unknown;

/** Fake channel exposing the SDK's public `onRawEvent` subscription. */
function fakeChannel(): { channel: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    channel: {
      onRawEvent(eventType: string, handler: Handler) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    },
  };
}

/** Client that answers join and swallows everything else. */
function fakeClient(meetingId = '70001'): VcRequestClient {
  return {
    request: vi.fn(async (p: { url: string }) => {
      if (p.url.endsWith('/join')) return { code: 0, data: { meeting: { id: meetingId } } } as never;
      return { code: 0, data: {} } as never;
    }),
  };
}

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return { ...MEETING_DEFAULTS, enabled: true, ...over };
}

function manager(opts: {
  channel?: unknown;
  config?: MeetingConfig;
  client?: VcRequestClient;
  onInvited?: (no: string) => void;
} = {}) {
  return new MeetingManager({
    client: opts.client ?? fakeClient(),
    config: () => opts.config ?? cfg(),
    ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    ...(opts.onInvited ? { onInvited: opts.onInvited } : {}),
  });
}

describe('MeetingManager push hook', () => {
  it('registers the three vc.bot.* events through channel.onRawEvent', () => {
    const { channel, handlers } = fakeChannel();
    const health = manager({ channel }).attachPush();

    expect(health.hooked).toBe(true);
    expect([...handlers.keys()].sort()).toEqual(
      [VC_BOT_EVENTS.activity, VC_BOT_EVENTS.ended, VC_BOT_EVENTS.invited].sort(),
    );
  });

  it('degrades with a reason (not a throw) when onRawEvent is unavailable', () => {
    // Simulates a channel-sdk older than 0.5.0, which has no onRawEvent.
    const health = manager({ channel: { somethingElse: true } }).attachPush();
    expect(health.hooked).toBe(false);
    expect(health.reason).toMatch(/onRawEvent/);
  });

  it('unsubscribes on dispose so a torn-down channel stops feeding it', () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel });
    m.attachPush();
    expect(handlers.size).toBe(3);

    m.dispose();
    expect(handlers.size).toBe(0);
    expect(m.pushHealth().hooked).toBe(false);
  });

  it('counts pushes so the console can prove the subscription works', async () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel });
    m.attachPush();
    expect(m.pushHealth().received).toBe(0);

    handlers.get(VC_BOT_EVENTS.activity)?.({ meeting_activity_items: [] });
    expect(m.pushHealth().received).toBe(1);
    expect(m.pushHealth().lastAt).toBeTruthy();
  });
});

describe('MeetingManager routing', () => {
  it('routes activity items to the session that owns the meeting id, ignoring others', async () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel, client: fakeClient('70001') });
    m.attachPush();
    const session = await m.join('123456789');

    handlers.get(VC_BOT_EVENTS.activity)?.({
      meeting_activity_items: [
        {
          event_id: 'e1',
          meeting: { id: '70001' },
          activity_event_type: 'transcript_received',
          transcript_received_items: [{ sentence_id: 1, text: '属于本会', speaker: { name: '甲' } }],
        },
        {
          // A meeting this process doesn't manage — must be dropped silently.
          event_id: 'e2',
          meeting: { id: 'other' },
          activity_event_type: 'transcript_received',
          transcript_received_items: [{ sentence_id: 2, text: '别的会', speaker: { name: '乙' } }],
        },
      ],
    });

    expect(session.recentTranscript()).toEqual(['甲: 属于本会']);
    // Receiving a push flips the reported source.
    expect(session.status().source).toBe('push');
  });

  it('marks the session ended on meeting_ended and drops it from the registry', async () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel });
    m.attachPush();
    const session = await m.join('123456789');
    expect(m.list()).toHaveLength(1);

    handlers.get(VC_BOT_EVENTS.ended)?.({ meeting: { id: session.meetingId } });

    expect(m.list()).toHaveLength(0);
    expect(session.ended).toBe(true);
  });

  it('notifies on invite but does not join when autoJoinOnInvite is off', async () => {
    const { channel, handlers } = fakeChannel();
    const seen: string[] = [];
    const m = manager({ channel, config: cfg({ autoJoinOnInvite: false }), onInvited: (n) => seen.push(n) });
    m.attachPush();

    handlers.get(VC_BOT_EVENTS.invited)?.({ meeting: { meeting_no: '123456789' } });
    await Promise.resolve();

    expect(seen).toEqual(['123456789']);
    expect(m.list()).toHaveLength(0);
  });

  it('auto-joins on invite when configured', async () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel, config: cfg({ autoJoinOnInvite: true }) });
    m.attachPush();

    handlers.get(VC_BOT_EVENTS.invited)?.({ meeting: { meeting_no: '123456789' } });

    await vi.waitFor(() => expect(m.list()).toHaveLength(1));
    expect(m.list()[0]?.meetingNo).toBe('123456789');
  });

  it('reuses the existing session when asked to join the same meeting twice', async () => {
    const client = fakeClient();
    const m = manager({ client });
    const a = await m.join('123456789');
    const b = await m.join('123456789');
    expect(b).toBe(a);
    expect(m.list()).toHaveLength(1);
  });

  it('dispose() stops local work without leaving the meetings', async () => {
    const client = fakeClient();
    const m = manager({ client });
    await m.join('123456789');
    m.dispose();
    expect(m.list()).toHaveLength(0);
    // join is the only call; no /leave was issued.
    const urls = (client.request as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(urls.filter((u) => u.endsWith('/leave'))).toHaveLength(0);
  });
});

describe('describeMeetingError', () => {
  it('explains the allowlisted-beta gate (20017) instead of leaking the raw code', () => {
    expect(describeMeetingError(new VcApiError(20017, 'ErrNotInGray', '/join'))).toMatch(/内测/);
  });

  it('passes other errors through', () => {
    expect(describeMeetingError(new Error('boom'))).toBe('boom');
  });
});

/**
 * The push hook rides the SDK's connection, so it is only as good as the
 * SDK-side contract it assumes. This pins that contract against the real
 * package rather than a fake — the previous implementation reached into a
 * TypeScript-private `dispatcher`, and channel 0.5.0 quietly broke it by
 * registering its own `vc.bot.*` handlers inside `connect()`.
 */
describe('push hook against the real @larksuite/channel', () => {
  it('subscribes through onRawEvent before connect()', async () => {
    const { createLarkChannel } = await import('@larksuite/channel');
    // Constructing does no I/O; nothing here connects.
    const channel = createLarkChannel({ appId: 'cli_test', appSecret: 'secret_test' });

    const health = manager({ channel }).attachPush();
    expect(health.hooked).toBe(true);
    expect(health.reason).toBeUndefined();
  });
});

describe('meeting end observed by the poller', () => {
  // Pushes may never arrive (no console subscription). The events API then
  // answers 122001 for an ended meeting; that must end the session exactly once
  // (→ summary) instead of polling a dead meeting and alarming the owner.
  it('ends the session once when polling hits 122001', async () => {
    let polls = 0;
    const client: VcRequestClient = {
      request: vi.fn(async (p: { url: string }) => {
        if (p.url.endsWith('/join')) return { code: 0, data: { meeting: { id: '70001' } } } as never;
        if (p.url.endsWith('/events')) {
          polls += 1;
          return { code: 122001, msg: 'meeting status unexpected' } as never;
        }
        return { code: 0, data: {} } as never;
      }),
    };
    const ended: string[] = [];
    const m = new MeetingManager({
      client,
      config: () => cfg({ pollIntervalMs: 5 }),
      onEnded: (s) => ended.push(s.meetingId),
    });
    const session = await m.join('123456789');
    let trouble = 0;
    session.onTrouble = () => (trouble += 1);
    await new Promise((r) => setTimeout(r, 60));

    expect(ended).toEqual(['70001']);
    expect(session.ended).toBe(true);
    expect(m.list()).toHaveLength(0);
    expect(polls).toBe(1); // stopped polling right away
    expect(trouble).toBe(0); // not reported as a polling failure
  });

  it('a later meeting_ended push for the same meeting does not summarize twice', async () => {
    const { channel, handlers } = fakeChannel();
    const client: VcRequestClient = {
      request: vi.fn(async (p: { url: string }) => {
        if (p.url.endsWith('/join')) return { code: 0, data: { meeting: { id: '70001' } } } as never;
        if (p.url.endsWith('/events')) return { code: 122001, msg: 'meeting status unexpected' } as never;
        return { code: 0, data: {} } as never;
      }),
    };
    const ended: string[] = [];
    const m = new MeetingManager({
      client,
      channel,
      config: () => cfg({ pollIntervalMs: 5 }),
      onEnded: (s) => ended.push(s.meetingId),
    });
    m.attachPush();
    await m.join('123456789');
    await new Promise((r) => setTimeout(r, 30));
    handlers.get(VC_BOT_EVENTS.ended)?.({ meeting: { id: '70001' } });
    expect(ended).toEqual(['70001']);
  });
});
