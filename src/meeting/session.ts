import { log } from '../core/logger';
import type { MeetingConfig } from '../config/profile-schema';
import {
  fetchMeetingEvents,
  leaveMeeting,
  sendMeetingText,
  VcApiError,
  type RawActivityItem,
  type VcRequestClient,
} from './api';
import { unpackActivity, type MeetingEvent, type TranscriptEvent } from './types';

export type MeetingEventSourceKind = 'push' | 'poll';

/** Consecutive poll failures before the owner is told. */
export const POLL_FAILURE_ALERT = 5;

export interface MeetingSessionStatus {
  meetingId: string;
  meetingNo: string;
  topic?: string;
  startedAt: string;
  /** Where in-meeting content is currently coming from. */
  source: MeetingEventSourceKind;
  transcriptLines: number;
  participants: number;
  /** Pushes/polls ingested — a quick health signal for the console. */
  ingested: number;
  /**
   * Count of raw activity items per `activity_event_type`, including types we
   * don't handle (prefixed `?`). This is what distinguishes "Feishu never sent
   * transcripts" from "it sent them and we failed to parse" — without it the
   * only symptom is a silent zero.
   */
  eventCounts: Record<string, number>;
  ended: boolean;
  /** In-meeting triggers refused by the authorization gate. */
  deniedCount: number;
}

export interface MeetingSessionDeps {
  client: VcRequestClient;
  meetingId: string;
  meetingNo: string;
  topic?: string;
  config: MeetingConfig;
  /** Bot's own open_id, used to drop self-echo transcript lines. */
  botOpenId?: string;
  /** Chat that started this session — where IM answers go back to. */
  originChatId?: string;
  now?: () => number;
}

/**
 * One live meeting. Owns the transcript buffer, de-duplication and the
 * end-of-life cleanup for a single meeting; the manager owns routing across
 * meetings. Deliberately has no knowledge of the agent — the orchestrator
 * subscribes via {@link on}.
 */
export class MeetingSession {
  readonly meetingId: string;
  readonly meetingNo: string;
  readonly topic?: string;
  readonly startedAt: string;
  readonly originChatId?: string;
  /** Set when the session was re-adopted after a bridge restart (epoch ms). */
  resumedAt?: number;
  /**
   * Called when the session hits a problem the user should hear about (the
   * orchestrator turns it into an owner DM). Currently: polling failed
   * {@link POLL_FAILURE_ALERT} times in a row.
   */
  onTrouble?: (kind: 'poll-failed', err: unknown) => void;
  /**
   * Called once when the poller sees the meeting has ended (`122001`). The
   * `meeting_ended` push is the other way to learn it, but pushes may never
   * arrive (no console subscription), and without this the session would poll
   * a dead meeting forever, never summarize, and alarm the owner about it.
   */
  onGone?: (err: VcApiError) => void;

  private readonly client: VcRequestClient;
  private readonly config: MeetingConfig;
  private readonly botOpenId?: string;
  private readonly now: () => number;

  /** Rolling transcript kept structurally so a re-sent sentence replaces in place. */
  private transcript: { sentenceId: string; speaker: string; text: string; seq: number }[] = [];
  /**
   * In-meeting chat lines. Chat is meeting content too: a meeting without
   * transcription (captions off) only has chat, and without this buffer the
   * agent's context and the end-of-meeting summary would both be empty.
   */
  private chatLines: { speaker: string; text: string; seq: number }[] = [];
  /**
   * Arrival order shared by transcript and chat lines. A counter, not a clock:
   * a poll page or a catch-up delivers many events in the same millisecond.
   */
  private seq = 0;
  /** sentence_id → latest text, so a re-sent sentence overwrites rather than appends. */
  private sentences = new Map<string, string>();
  /** event_id of already-ingested activity items (push replay / poll overlap). */
  private seenEvents = new Set<string>();
  /** Pending debounce timers when `stabilizeMs > 0`. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private handlers = new Map<string, Set<(e: MeetingEvent) => void>>();
  private participantIds = new Set<string>();

  private source: MeetingEventSourceKind = 'poll';
  private ingested = 0;
  private eventCounts: Record<string, number> = {};
  private cursor?: string;
  private poller?: ReturnType<typeof setTimeout>;
  private idleRounds = 0;
  private pollFailures = 0;
  private stopped = false;
  private leaving = false;
  ended = false;
  /** Bumped by the in-meeting authorization gate (see authz.ts). */
  deniedCount = 0;

  constructor(deps: MeetingSessionDeps) {
    this.client = deps.client;
    this.meetingId = deps.meetingId;
    this.meetingNo = deps.meetingNo;
    if (deps.topic) this.topic = deps.topic;
    this.config = deps.config;
    if (deps.botOpenId) this.botOpenId = deps.botOpenId;
    if (deps.originChatId) this.originChatId = deps.originChatId;
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = new Date(this.now()).toISOString();
  }

  status(): MeetingSessionStatus {
    return {
      meetingId: this.meetingId,
      meetingNo: this.meetingNo,
      ...(this.topic ? { topic: this.topic } : {}),
      startedAt: this.startedAt,
      source: this.source,
      transcriptLines: this.transcript.length,
      participants: this.participantIds.size,
      ingested: this.ingested,
      eventCounts: { ...this.eventCounts },
      ended: this.ended,
      deniedCount: this.deniedCount,
    };
  }

  /** Subscribe to a normalized event kind. Multiple handlers per kind. */
  on(kind: MeetingEvent['kind'], handler: (e: MeetingEvent) => void): () => void {
    let set = this.handlers.get(kind);
    if (!set) this.handlers.set(kind, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Latest transcript as `说话人: 内容` lines, oldest first — agent context. */
  recentTranscript(limit?: number): string[] {
    const slice =
      !limit || limit >= this.transcript.length ? this.transcript : this.transcript.slice(-limit);
    return slice.map((l) => `${l.speaker}: ${l.text}`);
  }

  /**
   * Transcript and in-meeting chat merged in arrival order, oldest first — the
   * agent's context. Chat lines are tagged so the agent can tell typed messages
   * from speech.
   */
  recentContext(limit?: number): string[] {
    const lines = [
      ...this.transcript.map((l) => ({ seq: l.seq, line: `${l.speaker}: ${l.text}` })),
      ...this.chatLines.map((c) => ({ seq: c.seq, line: `${c.speaker}（弹幕）: ${c.text}` })),
    ].sort((a, b) => a.seq - b.seq);
    const slice = !limit || limit >= lines.length ? lines : lines.slice(-limit);
    return slice.map((l) => l.line);
  }

  /** Number of buffered transcript lines (chat excluded). */
  transcriptLineCount(): number {
    return this.transcript.length;
  }

  /**
   * Events are arriving via push. Polling was the primary lane until now; keep
   * both and every event is delivered twice, so hand over and stop the poller.
   * The push lane is what the protocol intends for TAT; `bots/events` stays
   * available for an explicit gap-fill.
   */
  markPushActive(): void {
    if (this.source === 'push') return;
    this.source = 'push';
    if (this.poller) {
      this.stopPolling();
      log.info('meeting', 'poll-stopped-push-active', { meetingId: this.meetingId });
    }
  }

  /**
   * Ingest one raw activity item. Idempotent per `event_id`, so replayed pushes
   * and poll/push overlap during gap-fill collapse to one delivery.
   */
  ingest(item: RawActivityItem): void {
    if (this.ended) return;
    // Push and poll deliver the *same* content by design (poll is the gap-fill
    // lane), so every item can arrive twice. `event_id` is the intended dedup
    // key, but it isn't always present — without a fallback a duplicate chat
    // event fires a second agent run, which then gets rejected as
    // "another run is already active" and looks like a phantom stuck task.
    const eventId = item.event_id ?? contentDedupKey(item);
    if (eventId) {
      if (this.seenEvents.has(eventId)) return;
      this.seenEvents.add(eventId);
      // Bound the dedup set; meetings are long-lived and ids never repeat once
      // they've scrolled far enough out of the window.
      if (this.seenEvents.size > 5000) {
        for (const id of this.seenEvents) {
          this.seenEvents.delete(id);
          if (this.seenEvents.size <= 4000) break;
        }
      }
    }
    this.ingested += 1;
    const rawType = item.activity_event_type ?? (item as { event_type?: string }).event_type ?? 'unknown';
    const events = unpackActivity(item, this.botOpenId);
    // An item that yields nothing is either an unhandled type or a shape we
    // failed to read; mark it with `?` so the console shows it instead of
    // silently dropping it.
    const key = events.length === 0 ? `?${rawType}` : rawType;
    this.eventCounts[key] = (this.eventCounts[key] ?? 0) + 1;
    if (events.length === 0) {
      log.warn('meeting', 'activity-unparsed', {
        meetingId: this.meetingId,
        type: rawType,
        keys: Object.keys(item).join(','),
      });
    }
    for (const event of events) {
      this.handle(event);
    }
  }

  private handle(event: MeetingEvent): void {
    if (event.kind === 'transcript') {
      this.handleTranscript(event);
      return;
    }
    // message_type 3 is a reaction, not text.
    if (event.kind === 'chat' && event.messageType !== 3 && event.content) {
      this.chatLines.push({
        speaker: event.from.name ?? event.from.id ?? '?',
        text: event.content,
        seq: ++this.seq,
      });
      const keep = this.config.transcript.keep;
      if (this.chatLines.length > keep) this.chatLines = this.chatLines.slice(-keep);
    }
    if (event.kind === 'participant') {
      const id = event.user.id;
      if (id) {
        if (event.action === 'joined') this.participantIds.add(id);
        else this.participantIds.delete(id);
      }
    }
    this.emit(event);
  }

  private handleTranscript(event: TranscriptEvent): void {
    // The bot's own speech comes back through the meeting's transcription; not
    // filtering it here would let "answer whatever you hear" self-trigger.
    if (event.selfEcho) return;
    if (this.sentences.get(event.sentenceId) === event.text) return; // exact repeat
    this.sentences.set(event.sentenceId, event.text);

    const stabilizeMs = this.config.transcript.stabilizeMs;
    if (stabilizeMs <= 0) {
      this.commitTranscript(event);
      return;
    }
    // Debounce: a sentence is "final" once it stops growing for stabilizeMs.
    const prior = this.pending.get(event.sentenceId);
    if (prior) clearTimeout(prior);
    this.pending.set(
      event.sentenceId,
      setTimeout(() => {
        this.pending.delete(event.sentenceId);
        this.commitTranscript(event);
      }, stabilizeMs),
    );
  }

  /** Append (or replace) the sentence in the rolling buffer, then fan out. */
  private commitTranscript(event: TranscriptEvent): void {
    const line = {
      sentenceId: event.sentenceId,
      speaker: event.speaker.name ?? event.speaker.id ?? '?',
      text: event.text,
      seq: ++this.seq,
    };
    // Same sentence growing -> replace in place, so the buffer holds one entry
    // per sentence instead of every intermediate prefix. Keep the first arrival
    // position so the sentence doesn't jump past chat sent while it was spoken.
    const idx = this.transcript.findIndex((l) => l.sentenceId === event.sentenceId);
    if (idx >= 0) this.transcript[idx] = { ...line, seq: this.transcript[idx]!.seq };
    else this.transcript.push(line);
    const keep = this.config.transcript.keep;
    if (this.transcript.length > keep) this.transcript = this.transcript.slice(-keep);
    this.emit(event);
  }

  private emit(event: MeetingEvent): void {
    for (const handler of this.handlers.get(event.kind) ?? []) {
      try {
        handler(event);
      } catch (err) {
        log.warn('meeting', 'handler-failed', { kind: event.kind, err: String(err) });
      }
    }
  }

  /** Send a message into the meeting chat. */
  async sendMessage(text: string): Promise<void> {
    if (this.ended) return;
    await sendMeetingText(this.client, this.meetingId, text);
  }

  /**
   * Read the events the meeting already has, page by page, and leave the cursor
   * at the end. Used when re-adopting a meeting after a restart: it runs before
   * the agent subscribes, so old `@bot` questions fill the context without
   * being answered a second time. Throws on API errors — the caller decides
   * whether the meeting is gone.
   */
  async catchUp(maxPages = 1000): Promise<void> {
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchMeetingEvents(this.client, {
        meetingId: this.meetingId,
        ...(this.cursor ? { pageToken: this.cursor } : {}),
      });
      if (page.pageToken) this.cursor = page.pageToken;
      for (const item of page.items) this.ingest(item);
      if (!page.hasMore) return;
    }
    log.warn('meeting', 'catchup-truncated', { meetingId: this.meetingId, pages: maxPages });
  }

  /**
   * Start the `bots/events` poller. Used as the primary source until push is
   * proven, and as gap-fill afterwards. Idle rounds back off to 10s.
   */
  startPolling(): void {
    if (this.poller || this.stopped) return;
    const tick = async (): Promise<void> => {
      if (this.stopped || this.ended) return;
      try {
        const page = await fetchMeetingEvents(this.client, {
          meetingId: this.meetingId,
          ...(this.cursor ? { pageToken: this.cursor } : {}),
        });
        this.pollFailures = 0;
        if (page.pageToken) this.cursor = page.pageToken;
        for (const item of page.items) this.ingest(item);
        this.idleRounds = page.items.length > 0 ? 0 : Math.min(this.idleRounds + 1, 3);
        // More pages queued → come back immediately instead of sleeping.
        if (page.hasMore) this.idleRounds = -1;
      } catch (err) {
        if (err instanceof VcApiError && err.meetingGone) {
          log.info('meeting', 'ended-observed', { meetingId: this.meetingId, code: err.code });
          this.markEnded();
          this.onGone?.(err);
          return;
        }
        this.idleRounds = Math.min(this.idleRounds + 1, 3);
        log.warn('meeting', 'poll-failed', { meetingId: this.meetingId, err: String(err) });
        // Report once per streak: a poller that keeps failing means the bot is
        // deaf to the meeting, which is otherwise only visible in the log.
        this.pollFailures += 1;
        if (this.pollFailures === POLL_FAILURE_ALERT) this.onTrouble?.('poll-failed', err);
      }
      if (this.stopped || this.ended) return;
      const base = this.config.pollIntervalMs;
      const delay = this.idleRounds < 0 ? 0 : Math.min(base * 2 ** this.idleRounds, 10_000);
      this.poller = setTimeout(() => void tick(), delay);
    };
    this.poller = setTimeout(() => void tick(), 0);
  }

  private stopPolling(): void {
    if (this.poller) clearTimeout(this.poller);
    this.poller = undefined;
  }

  /** Called when the meeting ends server-side: stop work, keep the transcript. */
  markEnded(): void {
    this.ended = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    this.stopped = true;
    this.stopPolling();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Leave the meeting. Idempotent — safe to call after the meeting ended. */
  async leave(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.stopTimers();
    if (this.ended) return; // already over; nothing to leave
    this.ended = true;
    await leaveMeeting(this.client, this.meetingId).catch((err) =>
      log.warn('meeting', 'leave-failed', { meetingId: this.meetingId, err: String(err) }),
    );
  }

  /** Tear down local timers without calling the API (process shutdown). */
  dispose(): void {
    this.stopTimers();
    this.handlers.clear();
  }
}

/**
 * Stable key for an activity item that carries no `event_id`. Built from the
 * type plus the identity-bearing fields of its items, so the same event
 * arriving over both lanes collapses to one.
 */
function contentDedupKey(item: RawActivityItem): string | undefined {
  const type = item.activity_event_type ?? (item as { event_type?: string }).event_type;
  if (!type) return undefined;
  const payload = item as Record<string, unknown>;
  const nested = (payload.payload && typeof payload.payload === 'object' ? payload.payload : {}) as Record<string, unknown>;
  const arr = Object.entries({ ...payload, ...nested }).find(
    ([k, v]) => k.endsWith('_items') && Array.isArray(v),
  )?.[1] as unknown[] | undefined;
  if (!arr || arr.length === 0) return undefined;
  const parts = arr.map((entry) => {
    const it = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    // sentence_id / content identify a transcript line or chat message; the
    // timestamp disambiguates repeated identical text.
    return [
      it.sentence_id ?? it.message_id ?? '',
      it.content ?? it.text ?? '',
      it.start_time_ms ?? it.create_time ?? it.time ?? '',
      it.open_id ?? (it.sender as { open_id?: string } | undefined)?.open_id ?? '',
    ].join('|');
  });
  return `${type}#${parts.join('~')}`;
}
