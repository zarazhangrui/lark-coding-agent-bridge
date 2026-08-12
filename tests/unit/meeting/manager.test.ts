import { describe, expect, it, vi } from 'vitest';
import { MEETING_DEFAULTS, type MeetingConfig } from '../../../src/config/profile-schema';
import { MeetingManager, VC_BOT_EVENTS, describeMeetingError } from '../../../src/meeting/manager';
import { VcApiError, type VcRequestClient } from '../../../src/meeting/api';

type Handler = (data: unknown) => unknown;

/** Fake channel exposing the same (TS-private) `dispatcher` shape as the SDK. */
function fakeChannel(): { channel: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    channel: {
      dispatcher: {
        register(map: Record<string, Handler>) {
          for (const [k, v] of Object.entries(map)) handlers.set(k, v);
        },
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
  authorizeInviter?: (inviterId: string | undefined) => boolean;
  intakeEnabled?: () => boolean;
} = {}) {
  return new MeetingManager({
    client: opts.client ?? fakeClient(),
    config: () => opts.config ?? cfg(),
    ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    ...(opts.intakeEnabled ? { intakeEnabled: opts.intakeEnabled } : {}),
    ...(opts.onInvited ? { onInvited: opts.onInvited } : {}),
    ...(opts.authorizeInviter ? { authorizeInviter: opts.authorizeInviter } : {}),
  });
}

describe('MeetingManager push hook', () => {
  it('registers the three vc.bot.* events on the channel dispatcher', () => {
    const { channel, handlers } = fakeChannel();
    const health = manager({ channel }).attachPush();

    expect(health.hooked).toBe(true);
    expect([...handlers.keys()].sort()).toEqual(
      [VC_BOT_EVENTS.activity, VC_BOT_EVENTS.ended, VC_BOT_EVENTS.invited].sort(),
    );
  });

  it('degrades with a reason (not a throw) when the private dispatcher is gone', () => {
    // Simulates a channel-sdk upgrade that renamed/removed the field.
    const health = manager({ channel: { somethingElse: true } }).attachPush();
    expect(health.hooked).toBe(false);
    expect(health.reason).toMatch(/dispatcher/);
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

  it('ignores invites while its runtime generation is inactive', async () => {
    const { channel, handlers } = fakeChannel();
    const seen: string[] = [];
    const client = fakeClient();
    const m = manager({
      channel,
      client,
      config: cfg({ autoJoinOnInvite: true }),
      intakeEnabled: () => false,
      onInvited: (n) => seen.push(n),
    });
    m.attachPush();

    handlers.get(VC_BOT_EVENTS.invited)?.({ meeting: { meeting_no: '123456789' } });
    await Promise.resolve();

    expect(seen).toEqual([]);
    expect(m.list()).toHaveLength(0);
    expect(client.request).not.toHaveBeenCalled();
    expect(m.pushHealth().received).toBe(0);
  });

  it('auto-joins on invite when configured', async () => {
    const { channel, handlers } = fakeChannel();
    const m = manager({ channel, config: cfg({ autoJoinOnInvite: true }) });
    m.attachPush();

    handlers.get(VC_BOT_EVENTS.invited)?.({ meeting: { meeting_no: '123456789' } });

    await vi.waitFor(() => expect(m.list()).toHaveLength(1));
    expect(m.list()[0]?.meetingNo).toBe('123456789');
  });

  it('rejects an unauthorized invite before callbacks and auto-join', async () => {
    const { channel, handlers } = fakeChannel();
    const seen: string[] = [];
    const client = fakeClient();
    const m = manager({
      channel,
      client,
      config: cfg({ autoJoinOnInvite: true }),
      onInvited: (n) => seen.push(n),
      authorizeInviter: (openId) => openId === 'ou_owner',
    });
    m.attachPush();

    handlers.get(VC_BOT_EVENTS.invited)?.({
      meeting: { meeting_no: '123456789' },
      inviter: { open_id: 'ou_outsider' },
    });
    await Promise.resolve();

    expect(seen).toEqual([]);
    expect(m.list()).toHaveLength(0);
    expect(client.request).not.toHaveBeenCalled();
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
