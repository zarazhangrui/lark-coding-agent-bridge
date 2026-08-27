import { log } from '../core/logger';
import { t } from '../i18n';
import type { MeetingConfig } from '../config/profile-schema';
import { joinMeeting, VcApiError, type RawActivityItem, type VcRequestClient } from './api';
import { MeetingSession, type MeetingSessionStatus } from './session';
import type { MeetingEvent } from './types';

/**
 * Feishu pushes `vc.bot.meeting_activity_v1` at the **application** level: every
 * meeting this app is in arrives on one stream, keyed by `meeting.id`. This
 * manager owns that routing plus each meeting's lifecycle, so the rest of the
 * bridge deals in individual {@link MeetingSession}s.
 */

/** The three `vc.bot.*` events, as they appear on the wire. */
export const VC_BOT_EVENTS = {
  invited: 'vc.bot.meeting_invited_v1',
  activity: 'vc.bot.meeting_activity_v1',
  ended: 'vc.bot.meeting_ended_v1',
} as const;

/** Minimal shape of node-sdk's EventDispatcher that we register handlers on. */
interface DispatcherLike {
  register(handles: Record<string, (data: unknown) => Promise<unknown> | unknown>): unknown;
}

export interface MeetingPushHealth {
  /** Whether the dispatcher hook was installed successfully. */
  hooked: boolean;
  /** Why the hook could not be installed (private API changed / absent). */
  reason?: string;
  /** Count of `vc.bot.*` pushes observed — proves the console subscription works. */
  received: number;
  lastAt?: string;
}

export interface MeetingManagerDeps {
  client: VcRequestClient;
  /** Live config accessor — re-read per use so `/config` edits apply. */
  config: () => MeetingConfig;
  /** Late-bound: the bot's identity is only known after the channel connects. */
  botOpenId?: () => string | undefined;
  /**
   * The channel object. Its `dispatcher` is TypeScript-private but a real
   * runtime property; we probe it defensively rather than assuming.
   */
  channel?: unknown;
  /** Notified when a session is created, so the orchestrator can subscribe. */
  onSession?: (session: MeetingSession) => void;
  /** Bot was invited to a meeting (push only). */
  onInvited?: (meetingNo: string, inviterId?: string) => void;
  /** Meeting ended (push, or observed by the poller). */
  onEnded?: (session: MeetingSession) => void;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class MeetingManager {
  private sessions = new Map<string, MeetingSession>();
  private push: MeetingPushHealth = { hooked: false, received: 0 };
  private disposed = false;

  constructor(private deps: MeetingManagerDeps) {}

  pushHealth(): MeetingPushHealth {
    return { ...this.push };
  }

  list(): MeetingSessionStatus[] {
    return [...this.sessions.values()].map((s) => s.status());
  }

  get(meetingId: string): MeetingSession | undefined {
    return this.sessions.get(meetingId);
  }

  /** Find a session by its 9-digit meeting number. */
  byMeetingNo(meetingNo: string): MeetingSession | undefined {
    return [...this.sessions.values()].find((s) => s.meetingNo === meetingNo.trim());
  }

  /** Sessions in the order they were joined. */
  all(): MeetingSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Install handlers for the three `vc.bot.*` events on the channel's existing
   * event connection.
   *
   * Why reach into a private field: `@larksuite/channel` exposes only a closed
   * union of 9 event names, with no generic registration hook, and opening a
   * *second* long connection for the same app would let Feishu deliver the
   * bridge's own IM events to the other socket. Riding the existing dispatcher
   * is the only safe option. node-sdk's `EventDispatcher.register()` accepts
   * arbitrary event-type strings and `invoke()` dispatches purely by string, so
   * this is mechanically sound — but it is unsupported API, hence the probe and
   * the explicit `reason` when it fails (callers then rely on polling).
   */
  attachPush(): MeetingPushHealth {
    const dispatcher = asRecord(this.deps.channel).dispatcher as DispatcherLike | undefined;
    if (!dispatcher || typeof dispatcher.register !== 'function') {
      this.push = {
        hooked: false,
        reason: t('meeting.push.noDispatcher'),
        received: 0,
      };
      log.warn('meeting', 'push-hook-unavailable', { reason: this.push.reason });
      return this.pushHealth();
    }
    try {
      dispatcher.register({
        [VC_BOT_EVENTS.invited]: (data: unknown) => {
          this.notePush();
          this.handleInvited(data);
        },
        [VC_BOT_EVENTS.activity]: (data: unknown) => {
          this.notePush();
          this.handleActivity(data);
        },
        [VC_BOT_EVENTS.ended]: (data: unknown) => {
          this.notePush();
          this.handleEnded(data);
        },
      });
      this.push = { hooked: true, received: 0 };
      log.info('meeting', 'push-hooked', {});
    } catch (err) {
      this.push = { hooked: false, reason: t('meeting.push.registerFailed', { err: String(err) }), received: 0 };
      log.warn('meeting', 'push-hook-failed', { err: String(err) });
    }
    return this.pushHealth();
  }

  private notePush(): void {
    this.push.received += 1;
    this.push.lastAt = new Date().toISOString();
  }

  /** `vc.bot.meeting_invited_v1` → optionally auto-join. */
  private handleInvited(data: unknown): void {
    const d = asRecord(data);
    const meeting = asRecord(d.meeting);
    const meetingNo = typeof meeting.meeting_no === 'string' ? meeting.meeting_no : undefined;
    if (!meetingNo) {
      log.warn('meeting', 'invite-without-meeting-no', {});
      return;
    }
    const inviter = asRecord(d.operator ?? d.inviter);
    const inviterId = typeof inviter.open_id === 'string' ? inviter.open_id : undefined;
    log.info('meeting', 'invited', { meetingNo });
    this.deps.onInvited?.(meetingNo, inviterId);
    if (this.deps.config().autoJoinOnInvite) {
      void this.join(meetingNo).catch((err) =>
        log.warn('meeting', 'auto-join-failed', { meetingNo, err: String(err) }),
      );
    }
  }

  /** `vc.bot.meeting_activity_v1` → route each item to its session (doc 3.6). */
  private handleActivity(data: unknown): void {
    const items = asRecord(data).meeting_activity_items;
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = raw as RawActivityItem;
      const meetingId = item.meeting?.id;
      if (!meetingId) continue;
      const session = this.sessions.get(meetingId);
      // No session → this meeting isn't managed by this process; ignore.
      if (!session) continue;
      session.markPushActive();
      session.ingest(item);
    }
  }

  private handleEnded(data: unknown): void {
    const meetingId = asRecord(asRecord(data).meeting).id;
    if (typeof meetingId !== 'string') return;
    const session = this.sessions.get(meetingId);
    if (!session) return;
    log.info('meeting', 'ended', { meetingId });
    session.markEnded();
    this.sessions.delete(meetingId);
    this.deps.onEnded?.(session);
  }

  /**
   * Join a meeting by 9-digit number and start a session. Polling starts
   * regardless of push: it is the primary source until a push arrives, and the
   * gap-fill path afterwards.
   */
  async join(meetingNo: string, opts: { originChatId?: string; password?: string } = {}): Promise<MeetingSession> {
    const existing = this.byMeetingNo(meetingNo);
    if (existing && !existing.ended) return existing;

    const config = this.deps.config();
    const joined = await joinMeeting(this.deps.client, {
      meetingNo,
      ...(opts.password ? { password: opts.password } : {}),
    });
    const botOpenId = this.deps.botOpenId?.();
    const session = new MeetingSession({
      client: this.deps.client,
      meetingId: joined.meetingId,
      meetingNo: joined.meetingNo,
      ...(joined.topic ? { topic: joined.topic } : {}),
      config,
      ...(botOpenId ? { botOpenId } : {}),
      ...(opts.originChatId ? { originChatId: opts.originChatId } : {}),
    });
    this.sessions.set(session.meetingId, session);
    this.deps.onSession?.(session);
    session.startPolling();
    return session;
  }

  /** Leave a meeting and drop its session. Idempotent. */
  async leave(meetingId: string): Promise<boolean> {
    const session = this.sessions.get(meetingId);
    if (!session) return false;
    this.sessions.delete(meetingId);
    await session.leave();
    return true;
  }

  /** Leave every meeting — used on `/exit` and process shutdown. */
  async leaveAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.leave()));
  }

  /**
   * Stop local work without leaving the meetings. Used by `disconnect()`:
   * `/reconnect` tears the channel down and rebuilds it, and leaving every
   * meeting on a reconnect would be surprising.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/** Human-readable hint for the allowlisted-beta failure, else the raw message. */
export function describeMeetingError(err: unknown): string {
  if (err instanceof VcApiError && err.notInGray) {
    return t('meeting.notInGray');
  }
  return err instanceof Error ? err.message : String(err);
}

export type { MeetingEvent };
