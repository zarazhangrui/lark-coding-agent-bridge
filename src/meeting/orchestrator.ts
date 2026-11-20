import type { LarkChannel } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types';
import { claudeCapability, codexCapability } from '../agent/capability';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import type { RunExecutor } from '../runtime/run-executor';
import type { ActiveRuns } from '../bot/active-runs';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { startRunFlow } from '../bot/run-flow';
import { describeMeetingError } from './manager';
import type { MeetingSession } from './session';
import type { MeetingSummaryTarget } from '../config/profile-schema';
import type { ChatEvent, MeetingEvent } from './types';

/**
 * Turns in-meeting content into agent runs.
 *
 * Deliberate policy: the transcript is only ever **context**, never a trigger.
 * Running the coding agent because somebody said something out loud would be
 * both expensive and unsafe (an offhand remark could start editing code), so a
 * run needs an explicit ask — an in-meeting chat message prefixed with the
 * configured trigger, or a `/meeting ask` from IM.
 */

export interface MeetingAgentDeps {
  session: MeetingSession;
  channel: LarkChannel;
  controls: Controls;
  executor: RunExecutor;
  /** Needed to interrupt this meeting's run from inside the meeting. */
  activeRuns: ActiveRuns;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
}

/** Scope id for a meeting's agent session — one conversation per meeting. */
export function meetingScopeId(meetingId: string): string {
  return `meeting:${meetingId}`;
}

/**
 * Words that mean "stop the current run" when sent after the trigger. Runs are
 * serialized per meeting, so a hung run (e.g. an agent whose SessionEnd hook
 * never exits) would otherwise block every later question with no way out —
 * there is no `/stop` inside a meeting, only the chat lane.
 */
const STOP_WORDS = new Set(['stop', '停', '停止', '中断', '取消', 'cancel', 'abort']);

/**
 * Match an in-meeting chat line against the accepted trigger prefixes and
 * return what follows.
 *
 * Returns `undefined` when nothing matched, or the remaining text (possibly
 * empty) when it did — the caller needs to tell "not for me" apart from "for me
 * but nothing was asked".
 *
 * In-meeting chat is plain text with no mention autocomplete, so people type
 * whatever the bot is called in the participant list. Accepting `@<botName>`
 * alongside the configured prefix means the natural thing works with no config.
 * Punctuation right after the prefix is dropped, so a prefix followed by a
 * comma behaves the same as one followed by a space.
 */
export function matchTrigger(text: string, prefixes: string[]): string | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of prefixes) {
    const p = prefix.trim();
    if (!p) continue;
    if (!lower.startsWith(p.toLowerCase())) continue;
    return trimmed
      .slice(p.length)
      .replace(/^[\s,，、:：。.!！?？~～-]+/, '')
      .trim();
  }
  return undefined;
}

/** Configured prefix plus `@<botName>`, de-duplicated. */
export function triggerPrefixes(configured: string, botName?: string): string[] {
  const list = [configured, botName ? `@${botName}` : ''];
  return [...new Set(list.map((p) => p.trim()).filter(Boolean))];
}

/** Subscribe the agent to a freshly-created session. */
export function attachMeetingAgent(deps: MeetingAgentDeps): void {
  const { session, controls } = deps;
  session.onTrouble = (kind, err) =>
    notifyMeetingOwner(
      deps,
      kind,
      `会中事件拉取连续失败（${describeMeetingError(err)}），bot 可能收不到会中消息。`,
    );
  session.on('chat', (event) => {
    const chat = event as ChatEvent;
    // message_type 3 is an in-meeting reaction, not text — never a question.
    if (chat.messageType === 3) return;
    // Read the bot name live: it is only known after connect and can change.
    const prefixes = triggerPrefixes(
      controls.profileConfig.meeting.trigger,
      deps.channel.botIdentity?.name,
    );
    const question = matchTrigger(chat.content, prefixes);
    if (question === undefined) return; // not addressed to us
    if (!question) return; // addressed but empty
    const usedPrefix = prefixes.find((p) =>
      chat.content.trim().toLowerCase().startsWith(p.toLowerCase()),
    );

    if (STOP_WORDS.has(question.toLowerCase())) {
      const stopped = deps.activeRuns.interrupt(meetingScopeId(session.meetingId));
      void session
        .sendMessage(stopped ? '已中断当前任务。' : '当前没有正在执行的任务。')
        .catch((err) => log.warn('meeting', 'stop-reply-failed', { err: String(err) }));
      return;
    }

    // Asked from inside the meeting → answer where the conversation is.
    void answerInMeeting(deps, question, {
      deliver: 'broadcast',
      ...(usedPrefix ? { usedPrefix } : {}),
      ...(chat.from.name ? { askedBy: chat.from.name } : {}),
    }).catch((err) =>
      log.warn('meeting', 'answer-failed', { meetingId: session.meetingId, err: String(err) }),
    );
  });
}

export interface AnswerOptions {
  /** Name of the participant who asked (in-meeting triggers only). */
  askedBy?: string;
  /**
   * Who sees the answer.
   *  - `broadcast`: deliver per `respondIn` — used when the ask came from
   *    inside the meeting, where everyone is already in the conversation.
   *  - `caller`: return the text and deliver nothing — used by `/meeting
   *    notes|ask`, so a privately-typed command does NOT push its answer into
   *    the meeting where everybody would see it.
   */
  deliver: 'broadcast' | 'caller';
  /** Prefix the asker actually typed, so hints quote their wording back. */
  usedPrefix?: string;
}

/**
 * Run the agent with the meeting transcript as context. Returns the answer;
 * delivery depends on {@link AnswerOptions.deliver}.
 */
export async function answerInMeeting(
  deps: MeetingAgentDeps,
  question: string,
  opts: AnswerOptions,
): Promise<string> {
  const { session, controls } = deps;
  const config = controls.profileConfig.meeting;
  const transcript = session.recentContext(config.transcript.keep);
  const prompt = buildMeetingPrompt({
    question,
    transcript,
    topic: session.topic,
    ...(opts.askedBy ? { askedBy: opts.askedBy } : {}),
  });

  const answer = await runMeetingAgent(deps, prompt, opts.usedPrefix);
  if (!answer) return '';
  // The caller relays it themselves; never echo into the meeting.
  if (opts.deliver === 'caller') return answer;

  const target = config.respondIn;
  if (target === 'meeting' || target === 'both') {
    await session.sendMessage(answer).catch(async (err) => {
      const reason = describeMeetingError(err);
      log.warn('meeting', 'send-meeting-message-failed', { meetingId: session.meetingId, err: reason });
      // An answer that only exists in the log is lost. With respondIn=both and
      // an origin chat, the IM copy below already covers it. Otherwise DM the
      // owner only: the origin chat may be a group whose members aren't in the
      // meeting.
      if (target === 'both' && session.originChatId) return;
      const to = controls.botOwnerId;
      if (!to) return;
      await deps.channel
        .send(to, { markdown: `⚠️ 回答没能发进会议（${reason}），改私聊发给你：\n\n${answer}` })
        .catch((e) => log.warn('meeting', 'send-fallback-failed', { err: String(e) }));
    });
  }
  if ((target === 'im' || target === 'both') && session.originChatId) {
    await deps.channel
      .send(session.originChatId, { markdown: answer })
      .catch((err) => log.warn('meeting', 'send-im-failed', { err: String(err) }));
  }
  return answer;
}

export interface MeetingPromptInput {
  question: string;
  transcript: string[];
  topic?: string;
  askedBy?: string;
}

/** Compose the agent prompt: meeting context first, then the actual ask. */
export function buildMeetingPrompt(input: MeetingPromptInput): string {
  const parts: string[] = [];
  parts.push('你正在参加一场飞书视频会议，以下是会议的实时字幕和会中弹幕（标「弹幕」的是文字消息）。');
  if (input.topic) parts.push(`会议主题：${input.topic}`);
  parts.push('');
  parts.push('=== 会议记录（按时间顺序，可能不完整） ===');
  parts.push(input.transcript.length ? input.transcript.join('\n') : '（暂无字幕和弹幕）');
  parts.push('=== 记录结束 ===');
  parts.push('');
  parts.push(
    input.askedBy
      ? `参会人「${input.askedBy}」在会中向你提问：`
      : '收到的请求：',
  );
  parts.push(input.question);
  parts.push('');
  parts.push(
    '请基于上面的会议上下文作答。回答会被发到会议里，请简洁（尽量 200 字内），不要用 markdown 标题。',
  );
  return parts.join('\n');
}

const notifiedKinds = new WeakMap<MeetingSession, Set<string>>();

/**
 * Tell the bot owner about a meeting problem over DM. Once per meeting per
 * `kind`: these are "something is wrong" signals, not a stream.
 */
export function notifyMeetingOwner(
  deps: Pick<MeetingAgentDeps, 'session' | 'controls' | 'channel'>,
  kind: string,
  text: string,
): void {
  const { session, controls } = deps;
  const notified = notifiedKinds.get(session) ?? new Set<string>();
  notifiedKinds.set(session, notified);
  if (notified.has(kind)) return;
  notified.add(kind);
  const to = controls.botOwnerId;
  log.info('meeting', 'owner-notified', { meetingId: session.meetingId, kind, sent: Boolean(to) });
  if (!to) return;
  const title = session.topic ?? session.meetingNo;
  void deps.channel
    .send(to, { markdown: `⚠️ **会议智能体** · ${title}（${session.meetingNo}）\n${text}` })
    .catch((err) => log.warn('meeting', 'owner-notify-failed', { kind, err: String(err) }));
}

/**
 * Summarize a finished meeting and deliver it over IM.
 *
 * Runs after the meeting ended, so the in-meeting lane is gone — the summary
 * can only go to a chat. Target order: the chat the bot was told to join from,
 * else the bot owner's DM (`send` accepts an `ou_*` id as a direct message).
 * With neither, there is nowhere to put it, so we skip loudly instead of
 * silently dropping the work.
 *
 * Input is transcript + in-meeting chat: with captions off a meeting has no
 * transcript at all, and "no summary, no message" looked exactly like a broken
 * bot. When there is nothing, or the run / delivery fails, the owner is told.
 */
export async function summarizeEndedMeeting(deps: MeetingAgentDeps): Promise<void> {
  const { session, controls } = deps;
  if (!controls.profileConfig.meeting.summaryOnEnd) return;

  const transcriptLines = session.transcriptLineCount();
  const context = session.recentContext();
  if (context.length === 0) {
    log.info('meeting', 'summary-skipped', { meetingId: session.meetingId, reason: 'empty-transcript' });
    notifyMeetingOwner(
      deps,
      'summary-skipped',
      '会议已结束，但本场没收到任何字幕或弹幕，没有生成纪要。\n如果会上有人说话，多半是会议没开字幕/转写，bot 收不到语音内容。',
    );
    return;
  }
  const target = resolveSummaryTarget(
    controls.profileConfig.meeting.summaryTarget,
    session.originChatId,
    controls.botOwnerId,
  );
  if (!target) {
    log.warn('meeting', 'summary-no-target', { meetingId: session.meetingId });
    return;
  }

  // deliver:'caller' — the meeting is over, so never try the in-meeting lane.
  const answer = await answerInMeeting(
    deps,
    '会议已结束。请基于以上会议记录（字幕和弹幕）输出一份纪要：讨论了什么、达成的结论、待办（含负责人，如记录里有）。',
    { deliver: 'caller' },
  ).catch((err) => {
    log.warn('meeting', 'summary-run-failed', { meetingId: session.meetingId, err: String(err) });
    notifyMeetingOwner(deps, 'summary-run-failed', `会议已结束，但生成纪要失败：${String(err)}`);
    return '';
  });
  if (!answer) {
    notifyMeetingOwner(deps, 'summary-run-failed', '会议已结束，但生成纪要失败：agent 没有返回内容。');
    return;
  }

  const title = session.topic ?? session.meetingNo;
  const notes: string[] = [];
  if (transcriptLines === 0) notes.push('本场没收到字幕（可能没开转写），以上纪要只基于会中弹幕。');
  if (session.resumedAt) {
    const hhmm = new Date(session.resumedAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    notes.push(`bridge 在 ${hhmm} 重启后接回本场会议，此前的部分内容可能缺失。`);
  }
  const body =
    `**会议纪要 · ${title}**\n\n${answer}` + (notes.length ? `\n\n> ${notes.join('\n> ')}` : '');
  const sent = await deps.channel
    .send(target.to, { markdown: body })
    .then(() => true)
    .catch((err) => {
      log.warn('meeting', 'summary-send-failed', { err: String(err) });
      if (target.to !== controls.botOwnerId) {
        notifyMeetingOwner(deps, 'summary-send-failed', `纪要发到来源会话失败（${String(err)}），改发这里：\n\n${body}`);
      }
      return false;
    });
  if (!sent) return;
  log.info('meeting', 'summary-sent', {
    meetingId: session.meetingId,
    lines: context.length,
    transcriptLines,
    target: target.kind,
    fellBack: target.fellBack,
  });
}

export interface ResolvedSummaryTarget {
  to: string;
  kind: MeetingSummaryTarget;
  /** True when the preferred target was unavailable and the other one was used. */
  fellBack: boolean;
}

/**
 * Pick where the summary goes: the configured preference first, the other one as
 * a fallback. Keeping the fallback means a summary is never thrown away just
 * because the preferred lane is missing — a console-initiated join has no origin
 * chat, and an owner that never resolved has no DM.
 */
export function resolveSummaryTarget(
  preference: MeetingSummaryTarget,
  originChatId: string | undefined,
  botOwnerId: string | undefined,
): ResolvedSummaryTarget | undefined {
  const order: MeetingSummaryTarget[] =
    preference === 'owner' ? ['owner', 'origin'] : ['origin', 'owner'];
  for (const [index, kind] of order.entries()) {
    const to = kind === 'origin' ? originChatId : botOwnerId;
    if (to) return { to, kind, fellBack: index > 0 };
  }
  return undefined;
}

/** Submit one run and drain it into a single answer string. */
async function runMeetingAgent(
  deps: MeetingAgentDeps,
  prompt: string,
  usedPrefix?: string,
): Promise<string> {
  const { session, controls } = deps;
  const scopeId = meetingScopeId(session.meetingId);
  const capability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
  const result = await startRunFlow({
    scopeId,
    scope: {
      source: 'meeting',
      actorId: controls.botOwnerId ?? 'meeting',
      ...(session.originChatId ? { chatId: session.originChatId } : {}),
    },
    prompt,
    attachments: [],
    // Meeting content is already gated by "the bot was invited into the
    // meeting"; the per-chat allowlist doesn't apply here.
    access: { ok: true, reason: 'allowed-chat' },
    capability,
    profileConfig: controls.profileConfig,
    sessions: deps.sessions,
    ...(deps.sessionCatalog ? { sessionCatalog: deps.sessionCatalog } : {}),
    workspaces: deps.workspaces,
    executor: deps.executor,
    now: Date.now(),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'meeting',
      stage: 'submit',
    },
  });

  if (!result.ok) {
    log.info('meeting', 'run-rejected', {
      meetingId: session.meetingId,
      reason: result.rejectReason.code,
    });
    // The generic "already running" text is a dead end inside a meeting, where
    // /stop isn't reachable — point at the in-meeting escape hatch instead.
    if (result.rejectReason.code === 'run-already-active') {
      // Quote back whatever the asker typed: answering someone who used the
      // bot-name prefix with the configured one reads like a different bot.
      const prefix =
        usedPrefix ??
        triggerPrefixes(controls.profileConfig.meeting.trigger, deps.channel.botIdentity?.name)[0] ??
        controls.profileConfig.meeting.trigger;
      return `上一个任务还在执行。发「${prefix} stop」可以中断它，然后再问我。`;
    }
    return result.rejectReason.userVisible;
  }

  let answer = '';
  for await (const event of result.execution.subscribe()) {
    const chunk = textOf(event);
    if (chunk) answer += chunk;
    if (event.type === 'error') {
      log.warn('meeting', 'run-error', { meetingId: session.meetingId });
    }
  }
  return answer.trim();
}

/** Collect assistant text from the agent event stream. */
function textOf(event: AgentEvent): string {
  return event.type === 'text' ? event.delta : '';
}

export type { MeetingEvent };
