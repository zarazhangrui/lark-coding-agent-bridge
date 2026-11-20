import type { RawActivityItem } from './api';

/**
 * Normalized in-meeting events. The wire format nests two levels deep and uses
 * a different array field per activity type; {@link unpackActivity} flattens
 * that into these.
 */

export interface MeetingActor {
  id?: string;
  name?: string;
}

export interface TranscriptEvent {
  kind: 'transcript';
  speaker: MeetingActor;
  text: string;
  /** Stable per sentence — later items with the same id supersede earlier ones. */
  sentenceId: string;
  startMs?: number;
  endMs?: number;
  language?: string;
  /** True when the speaker is our own bot (its speech is transcribed back). */
  selfEcho: boolean;
}

export interface ChatEvent {
  kind: 'chat';
  from: MeetingActor;
  content: string;
  /** Feishu's in-meeting message type; `3` is a reaction rather than text. */
  messageType?: number;
}

export interface ParticipantEvent {
  kind: 'participant';
  action: 'joined' | 'left';
  user: MeetingActor;
  leaveReason?: string;
}

export interface ShareEvent {
  kind: 'share';
  action: 'started' | 'ended';
  url?: string;
  title?: string;
}

export type MeetingEvent = TranscriptEvent | ChatEvent | ParticipantEvent | ShareEvent;

/** `activity_event_type` → the array field carrying its items (doc 3.4). */
const ARRAY_FIELD: Record<string, string> = {
  transcript_received: 'transcript_received_items',
  chat_received: 'chat_received_items',
  participant_joined: 'participant_joined_items',
  participant_left: 'participant_left_items',
  magic_share_started: 'magic_share_started_items',
  magic_share_ended: 'magic_share_ended_items',
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull the actor out of an item. The wire format is inconsistent about the
 * wrapper key (`speaker` / `user` / `operator` / `sender` / flat), so probe.
 */
function actor(item: Record<string, unknown>, ...keys: string[]): MeetingActor {
  for (const key of keys) {
    const wrapped = asRecord(item[key]);
    const id = str(wrapped.open_id) ?? str(wrapped.user_id) ?? str(wrapped.id);
    const name = str(wrapped.name) ?? str(wrapped.user_name);
    if (id || name) return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  const id = str(item.open_id) ?? str(item.user_id);
  const name = str(item.name) ?? str(item.user_name) ?? str(item.speaker_name);
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
}

/**
 * Flatten one activity item into normalized events (the second unpack layer).
 * A single push can carry dozens of transcript lines — taking only the first
 * would silently drop data, which is why this returns an array.
 */
export function unpackActivity(item: RawActivityItem, botOpenId?: string): MeetingEvent[] {
  const type = item.activity_event_type ?? (item as { event_type?: string }).event_type;
  if (!type) return [];
  const field = ARRAY_FIELD[type];
  if (!field) return [];
  // The push payload carries the items flat on the activity object, while the
  // structured/CLI shape nests them under `payload`. Accept either.
  const raw = item[field] ?? asRecord(item.payload)[field];
  const arr = Array.isArray(raw) ? raw : [];
  const out: MeetingEvent[] = [];

  for (const entry of arr) {
    const it = asRecord(entry);
    switch (type) {
      case 'transcript_received': {
        const text = str(it.text) ?? str(it.content) ?? '';
        const sentenceId = String(it.sentence_id ?? it.sentenceId ?? '');
        if (!text || !sentenceId) break;
        // `operator` last: no real transcript sample yet, so existing keys keep priority.
        const speaker = actor(it, 'speaker', 'user', 'sender', 'operator');
        out.push({
          kind: 'transcript',
          speaker,
          text,
          sentenceId,
          ...(num(it.start_time_ms ?? it.start_ms) !== undefined
            ? { startMs: num(it.start_time_ms ?? it.start_ms) }
            : {}),
          ...(num(it.end_time_ms ?? it.end_ms) !== undefined
            ? { endMs: num(it.end_time_ms ?? it.end_ms) }
            : {}),
          ...(str(it.language) ? { language: str(it.language) } : {}),
          selfEcho: Boolean(botOpenId && speaker.id === botOpenId),
        });
        break;
      }
      case 'chat_received': {
        const content = str(it.content) ?? str(it.text) ?? '';
        if (!content) break;
        out.push({
          kind: 'chat',
          // Real chat_received items carry the sender as
          // `operator: { id, user_name }`; without it `from` is always empty.
          from: actor(it, 'operator', 'sender', 'user', 'from'),
          content,
          ...(num(it.message_type) !== undefined ? { messageType: num(it.message_type) } : {}),
        });
        break;
      }
      case 'participant_joined':
      case 'participant_left':
        out.push({
          kind: 'participant',
          action: type === 'participant_joined' ? 'joined' : 'left',
          user: actor(it, 'user', 'participant'),
          ...(str(it.leave_reason) ? { leaveReason: str(it.leave_reason) } : {}),
        });
        break;
      case 'magic_share_started':
      case 'magic_share_ended':
        out.push({
          kind: 'share',
          action: type === 'magic_share_started' ? 'started' : 'ended',
          ...(str(it.url) ? { url: str(it.url) } : {}),
          ...(str(it.title) ? { title: str(it.title) } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}
