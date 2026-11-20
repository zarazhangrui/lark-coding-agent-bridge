import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../core/logger';
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

/**
 * The slice of `LarkChannel` we subscribe through: `onRawEvent`, public since
 * `@larksuite/channel` 0.5.0. Declared structurally so the manager stays
 * testable with a fake and does not depend on the SDK's class type.
 */
interface RawEventSource {
  onRawEvent(
    eventType: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
}

export interface MeetingPushHealth {
  /** Whether the `vc.bot.*` subscription was installed successfully. */
  hooked: boolean;
  /** Why it could not be installed (SDK too old / absent channel). */
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
   * The channel object. Only its `onRawEvent` is used, and it is probed rather
   * than assumed so an older SDK degrades to polling instead of throwing.
   */
  channel?: unknown;
  /** Notified when a session is created, so the orchestrator can subscribe. */
  onSession?: (session: MeetingSession) => void;
  /** Bot was invited to a meeting (push only). */
  onInvited?: (meetingNo: string, inviterId?: string) => void;
  /** Meeting ended (push, or observed by the poller). */
  onEnded?: (session: MeetingSession) => void;
  /** Auto-join after an invite failed — the inviter only sees a bot that never came. */
  onAutoJoinFailed?: (meetingNo: string, err: unknown) => void;
  /**
   * Where live meetings are recorded so a restarted bridge can re-adopt them
   * (`dispose()` keeps the bot in the meeting). Omit to disable.
   */
  stateFile?: string;
  /** A recorded meeting could not be re-adopted because it ended while the bridge was down. */
  onResumeEnded?: (meeting: PersistedMeeting, err: VcApiError) => void;
}

/** One live meeting as written to {@link MeetingManagerDeps.stateFile}. */
export interface PersistedMeeting {
  meetingId: string;
  meetingNo: string;
  topic?: string;
  originChatId?: string;
  startedAt?: string;
}

/** What the events API answers for a meeting that has ended (observed). */
const MEETING_GONE_CODE = 122001;
/** Recorded meetings older than this are not re-adopted. */
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class MeetingManager {
  private sessions = new Map<string, MeetingSession>();
  private push: MeetingPushHealth = { hooked: false, received: 0 };
  /** `onRawEvent` teardown functions, so `dispose()` stops feeding a dead manager. */
  private unsubscribers: (() => void)[] = [];
  private disposed = false;
  /** Recorded meetings whose re-adoption failed transiently; kept for the next start. */
  private unresumed: PersistedMeeting[] = [];

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
   * Subscribe to the three `vc.bot.*` events on the channel's existing event
   * connection, via the SDK's public `onRawEvent`.
   *
   * Riding the existing connection is not optional: a *second* long connection
   * for the same app makes Feishu split delivery between the two, so the
   * bridge's own IM events start disappearing.
   *
   * This used to reach into the channel's TypeScript-private `dispatcher` and
   * call node-sdk's `register()` directly. That stopped being safe in channel
   * 0.5.0, which registers its own `vc.bot.*` handlers inside `connect()`:
   * `register()` overwrites a duplicate key (it only logs an error), and
   * `attachPush()` runs *before* `connect()`, so the SDK's handlers would have
   * silently replaced ours and the pushes would have gone nowhere.
   * `onRawEvent` composes instead — built-ins first, then raw subscribers — and
   * the SDK's own meeting handlers are inert here because the bridge never
   * opens an SDK-native `MeetingSession`.
   */
  attachPush(): MeetingPushHealth {
    const channel = this.deps.channel as RawEventSource | undefined;
    if (typeof channel?.onRawEvent !== 'function') {
      this.push = {
        hooked: false,
        reason: 'channel 不支持 onRawEvent（需要 @larksuite/channel >= 0.5.0），已降级为轮询',
        received: 0,
      };
      log.warn('meeting', 'push-hook-unavailable', { reason: this.push.reason });
      return this.pushHealth();
    }
    try {
      const handlers: Record<string, (data: unknown) => void> = {
        [VC_BOT_EVENTS.invited]: (data) => this.handleInvited(data),
        [VC_BOT_EVENTS.activity]: (data) => this.handleActivity(data),
        [VC_BOT_EVENTS.ended]: (data) => this.handleEnded(data),
      };
      for (const [eventType, handle] of Object.entries(handlers)) {
        this.unsubscribers.push(
          channel.onRawEvent(eventType, (data) => {
            this.notePush();
            handle(data);
          }),
        );
      }
      this.push = { hooked: true, received: 0 };
      log.info('meeting', 'push-hooked', {});
    } catch (err) {
      this.detachPush();
      this.push = { hooked: false, reason: `注册事件失败：${String(err)}`, received: 0 };
      log.warn('meeting', 'push-hook-failed', { err: String(err) });
    }
    return this.pushHealth();
  }

  /** Drop the `vc.bot.*` subscriptions. Idempotent. */
  private detachPush(): void {
    const offs = this.unsubscribers.splice(0);
    for (const off of offs) {
      try {
        off();
      } catch {
        // A channel torn down under us — nothing left to unsubscribe from.
      }
    }
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
      void this.join(meetingNo).catch((err) => {
        log.warn('meeting', 'auto-join-failed', { meetingNo, err: String(err) });
        this.deps.onAutoJoinFailed?.(meetingNo, err);
      });
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
    this.persist();
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
    this.persist();
    return session;
  }

  /**
   * Re-adopt the meetings recorded by a previous run. Each one is caught up
   * (existing events read into the buffer before the agent subscribes, so old
   * questions aren't answered twice) and then polled as usual.
   *
   * `122001` (what the events API returns once a meeting has ended) drops the
   * record and fires `onResumeEnded`. Any other failure — network, rate limit,
   * token — keeps it for the next start; records older than a day are dropped.
   * Known gap: a question asked while the bridge was down is treated as old
   * and not answered.
   */
  async resume(): Promise<void> {
    const file = this.deps.stateFile;
    if (!file || this.disposed) return;
    let records: PersistedMeeting[];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meetings?: unknown };
      records = Array.isArray(parsed.meetings) ? (parsed.meetings as PersistedMeeting[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('meeting', 'resume-read-failed', { err: String(err) });
      }
      return;
    }
    // Keep every record until it is settled: a join/leave persisting mid-resume
    // must not wipe the ones not reached yet.
    this.unresumed = records.filter((r) => r?.meetingId && r.meetingNo);
    const settle = (r: PersistedMeeting) => {
      this.unresumed = this.unresumed.filter((x) => x !== r);
    };
    const cutoff = Date.now() - RESUME_MAX_AGE_MS;
    for (const r of [...this.unresumed]) {
      if (this.sessions.has(r.meetingId)) {
        settle(r);
        continue;
      }
      if (r.startedAt && Date.parse(r.startedAt) < cutoff) {
        log.info('meeting', 'resume-expired', { meetingNo: r.meetingNo });
        settle(r);
        continue;
      }
      const botOpenId = this.deps.botOpenId?.();
      const session = new MeetingSession({
        client: this.deps.client,
        meetingId: r.meetingId,
        meetingNo: r.meetingNo,
        ...(r.topic ? { topic: r.topic } : {}),
        config: this.deps.config(),
        ...(botOpenId ? { botOpenId } : {}),
        ...(r.originChatId ? { originChatId: r.originChatId } : {}),
      });
      try {
        await session.catchUp();
      } catch (err) {
        session.dispose();
        if (err instanceof VcApiError && err.code === MEETING_GONE_CODE) {
          log.info('meeting', 'resume-dropped', { meetingNo: r.meetingNo, code: err.code });
          settle(r);
          this.deps.onResumeEnded?.(r, err);
        } else {
          log.warn('meeting', 'resume-failed', { meetingNo: r.meetingNo, err: String(err) });
        }
        continue;
      }
      if (this.disposed) {
        session.dispose();
        return;
      }
      settle(r);
      if (this.sessions.has(r.meetingId)) {
        session.dispose(); // joined again while we were catching up
        continue;
      }
      session.resumedAt = Date.now();
      this.sessions.set(session.meetingId, session);
      this.deps.onSession?.(session);
      session.startPolling();
      log.info('meeting', 'resumed', { meetingNo: r.meetingNo, replayed: session.status().ingested });
    }
    this.persist();
  }

  /** Write the live meetings to `stateFile` (atomic replace). Never throws. */
  private persist(): void {
    const file = this.deps.stateFile;
    // A join still in flight on a disposed manager must not overwrite the new one's file.
    if (!file || this.disposed) return;
    try {
      const live: PersistedMeeting[] = [...this.sessions.values()]
        .filter((s) => !s.ended)
        .map((s) => ({
          meetingId: s.meetingId,
          meetingNo: s.meetingNo,
          ...(s.topic ? { topic: s.topic } : {}),
          ...(s.originChatId ? { originChatId: s.originChatId } : {}),
          startedAt: s.startedAt,
        }));
      const ids = new Set(live.map((m) => m.meetingId));
      const meetings = [...live, ...this.unresumed.filter((m) => !ids.has(m.meetingId))];
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ meetings }, null, 2)}\n`);
      renameSync(tmp, file);
    } catch (err) {
      log.warn('meeting', 'persist-failed', { err: String(err) });
    }
  }

  /** Leave a meeting and drop its session. Idempotent. */
  async leave(meetingId: string): Promise<boolean> {
    const session = this.sessions.get(meetingId);
    if (!session) return false;
    this.sessions.delete(meetingId);
    this.persist();
    await session.leave();
    return true;
  }

  /** Leave every meeting — used on `/exit` and process shutdown. */
  async leaveAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.persist();
    await Promise.allSettled(all.map((s) => s.leave()));
  }

  /**
   * Stop local work without leaving the meetings. Used by `disconnect()`:
   * `/reconnect` tears the channel down and rebuilds it, and leaving every
   * meeting on a reconnect would be surprising. `stateFile` is left as is, so
   * the next start can {@link resume} them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachPush();
    this.push = { ...this.push, hooked: false };
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/** Human-readable hint for the allowlisted-beta failure, else the raw message. */
export function describeMeetingError(err: unknown): string {
  if (err instanceof VcApiError && err.notInGray) {
    return '智能体入会能力尚未对本应用开通（错误码 20017）。需要先申请加入内测，再重试。';
  }
  return err instanceof Error ? err.message : String(err);
}

export type { MeetingEvent };
