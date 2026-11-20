import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawActivityItem, VcRequestClient } from '../../../src/meeting/api';
import type { MeetingConfig } from '../../../src/config/profile-schema';

/**
 * The end-to-end meeting path: a chat `@bot` from a real-shaped event reaches
 * the agent, chat-only meetings still get a summary, and every failure on the
 * way surfaces to the owner instead of only the log.
 */

const mocks = vi.hoisted(() => ({ startRunFlow: vi.fn() }));
vi.mock('../../../src/bot/run-flow', () => ({ startRunFlow: mocks.startRunFlow }));

const { answerInMeeting, attachMeetingAgent, summarizeEndedMeeting } = await import(
  '../../../src/meeting/orchestrator'
);
const { MeetingSession, POLL_FAILURE_ALERT } = await import('../../../src/meeting/session');
const { MEETING_DEFAULTS, createDefaultProfileConfig } = await import(
  '../../../src/config/profile-schema'
);

/**
 * A `chat_received` item in the shape the events API actually returns (ids
 * and text replaced). Note the sender lives under `operator`, with `id` and
 * `user_name` — not `sender` / `open_id`.
 */
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

function chat(eventId: string, content: string, messageType = 1): RawActivityItem {
  return {
    event_id: eventId,
    meeting: { id: '70001' },
    activity_event_type: 'chat_received',
    chat_received_items: [{ content, message_type: messageType, operator: { id: 'ou_b', user_name: '乙' } }],
  } as RawActivityItem;
}

function transcript(id: string, text: string): RawActivityItem {
  return {
    event_id: `t-${id}-${text}`,
    meeting: { id: '70001' },
    activity_event_type: 'transcript_received',
    transcript_received_items: [{ sentence_id: id, text, speaker: { open_id: 'ou_a', name: '甲' } }],
  };
}

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return { ...MEETING_DEFAULTS, enabled: true, summaryOnEnd: true, ...over };
}

function profileConfig(meeting: MeetingConfig) {
  const pc = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  pc.meeting = meeting;
  return pc;
}

function fakeRun(text: string) {
  return {
    ok: true as const,
    execution: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          if (text) yield { type: 'text', delta: text };
          yield { type: 'done' };
        },
      }),
    },
    policy: {},
    cwdRealpath: '/repo',
  };
}

let clock = 1_000;
function makeSession(config: MeetingConfig, opts: { originChatId?: string; client?: VcRequestClient } = {}) {
  return new MeetingSession({
    client: opts.client ?? { request: vi.fn(async () => ({ code: 0, data: {} }) as never) },
    meetingId: '70001',
    meetingNo: '123456789',
    topic: '周会',
    config,
    now: () => clock,
    ...(opts.originChatId ? { originChatId: opts.originChatId } : {}),
  });
}

function deps(
  session: InstanceType<typeof MeetingSession>,
  config: MeetingConfig,
  opts: { botOwnerId?: string; failTo?: string } = {},
) {
  const sent: { to: string; markdown: string }[] = [];
  return {
    sent,
    args: {
      session,
      channel: {
        botIdentity: { name: 'bot' },
        send: vi.fn(async (to: string, input: { markdown: string }) => {
          if (to === opts.failTo) throw new Error('chat disbanded');
          sent.push({ to, markdown: input.markdown });
          return {} as never;
        }),
      },
      controls: {
        profile: 'claude',
        profileConfig: profileConfig(config),
        ...(opts.botOwnerId ? { botOwnerId: opts.botOwnerId } : {}),
      },
      executor: {},
      activeRuns: { interrupt: vi.fn() },
      sessions: {},
      workspaces: {},
    } as never,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  clock = 1_000;
  mocks.startRunFlow.mockResolvedValue(fakeRun('结论：周五上线。'));
});

describe('in-meeting @ from a real chat event', () => {
  it('hands the asker name to the agent for a real in-meeting @', async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    attachMeetingAgent(deps(s, config, { botOwnerId: 'ou_asker' }).args);
    s.ingest(REAL_CHAT);
    await flush();
    expect(mocks.startRunFlow).toHaveBeenCalledTimes(1);
    expect(mocks.startRunFlow.mock.calls[0]![0].prompt).toContain('参会人「张三」');
  });

  it('accepts the mention at the end of the sentence', async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    attachMeetingAgent(deps(s, config, { botOwnerId: 'ou_b' }).args);
    s.ingest(chat('e-tail', '说句话听听 @bot'));
    await flush();
    expect(mocks.startRunFlow).toHaveBeenCalledTimes(1);
  });

  it("ignores the bot's own answer even when it quotes the trigger", async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    const d = deps(s, config);
    (d.args as { channel: { botIdentity: unknown } }).channel.botIdentity = {
      name: 'bot',
      openId: 'ou_b',
    };
    attachMeetingAgent(d.args);
    // `chat()` sends as ou_b — here that is the bot itself
    s.ingest(chat('e-self', '有事直接 @bot 叫我'));
    await flush();
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
  });
});

describe('in-meeting authorization', () => {
  it('refuses a participant who may not DM the bot, replies once, runs nothing', async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    const said: string[] = [];
    s.sendMessage = vi.fn(async (t: string) => {
      said.push(t);
    });
    attachMeetingAgent(deps(s, config, { botOwnerId: 'ou_owner' }).args);
    s.ingest(chat('e-1', '@bot 帮我删库'));
    s.ingest(chat('e-2', '@bot 再试一次'));
    await flush();
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('尚未获得');
    expect(s.status().deniedCount).toBe(2);
  });

  it('lets an allowlisted colleague through and runs read-only', async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    (d.args as { controls: { profileConfig: { access: { allowedUsers: string[] } } } }).controls.profileConfig.access.allowedUsers = ['ou_b'];
    attachMeetingAgent(d.args);
    s.ingest(chat('e-1', '@bot 总结一下'));
    await flush();
    expect(mocks.startRunFlow).toHaveBeenCalledTimes(1);
    const call = mocks.startRunFlow.mock.calls[0]![0];
    expect(call.capability.permissions.maxAccess).toBe('read-only');
    expect(call.prompt).toContain('只读权限');
    expect(call.access).toEqual({ ok: true, reason: 'allowed-user' });
  });

  it('a stop word from an unauthorized participant does not interrupt the run', async () => {
    const config = cfg({ trigger: '@bot' });
    const s = makeSession(config);
    s.sendMessage = vi.fn(async () => {});
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    attachMeetingAgent(d.args);
    s.ingest(chat('e-1', '@bot 停'));
    await flush();
    expect((d.args as { activeRuns: { interrupt: ReturnType<typeof vi.fn> } }).activeRuns.interrupt).not.toHaveBeenCalled();
  });

  it('elevates only when the elevation word directly follows the trigger', async () => {
    const config = cfg({ trigger: '@bot', elevateWord: '!write' });
    const s = makeSession(config);
    const said: string[] = [];
    s.sendMessage = vi.fn(async (t: string) => {
      said.push(t);
    });
    const d = deps(s, config, { botOwnerId: 'ou_b' });
    const pc = (d.args as { controls: { profileConfig: { permissions: { defaultAccess: string; maxAccess: string } } } }).controls.profileConfig;
    pc.permissions.defaultAccess = 'workspace';
    pc.permissions.maxAccess = 'full';
    attachMeetingAgent(d.args);

    s.ingest(chat('e-1', '@bot 别用 !write 了，先看看'));
    await flush();
    expect(mocks.startRunFlow.mock.calls[0]![0].capability.permissions.maxAccess).toBe('read-only');
    expect(said.some((t) => t.includes('写权限'))).toBe(false);

    s.ingest(chat('e-2', '@bot !write 改一下 README'));
    await flush();
    const second = mocks.startRunFlow.mock.calls[1]![0];
    expect(second.capability.permissions.maxAccess).toBe('workspace');
    expect(second.prompt).toContain('改一下 README');
    expect(said.some((t) => t.includes('本次以 workspace 权限执行'))).toBe(true);
  });
});

describe('entries other than meeting chat are read-only', () => {
  it('/meeting ask and notes run read-only even when the meeting tier is higher', async () => {
    const config = cfg({ executionAccess: 'workspace' });
    const s = makeSession(config);
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    const pc = (d.args as { controls: { profileConfig: { permissions: { maxAccess: string } } } }).controls.profileConfig;
    pc.permissions.maxAccess = 'full';
    await answerInMeeting(d.args, '总结', { deliver: 'caller' });
    expect(mocks.startRunFlow.mock.calls[0]![0].capability.permissions.maxAccess).toBe('read-only');
    await answerInMeeting(d.args, '总结', { deliver: 'broadcast' });
    expect(mocks.startRunFlow.mock.calls[1]![0].capability.permissions.maxAccess).toBe('workspace');
  });
});

describe('meeting context = transcript + chat', () => {
  it('merges both by arrival time, tags chat, and skips reactions', () => {
    const s = makeSession(cfg());
    clock = 1;
    s.ingest(transcript('s1', '先过排期'));
    clock = 2;
    s.ingest(REAL_CHAT);
    clock = 3;
    s.ingest(chat('r1', '👍', 3));
    clock = 4;
    s.ingest(transcript('s2', '周五上线'));
    clock = 5;
    s.ingest(transcript('s1', '先过一下排期'));
    expect(s.recentContext()).toEqual([
      '甲: 先过一下排期',
      '张三（弹幕）: @bot 帮我整理一下刚才的结论',
      '甲: 周五上线',
    ]);
    expect(s.recentTranscript()).toHaveLength(2);
    expect(s.recentContext(1)).toEqual(['甲: 周五上线']);
  });

  it('caps the chat buffer at transcript.keep', () => {
    const s = makeSession(cfg({ transcript: { ...MEETING_DEFAULTS.transcript, keep: 2 } }));
    for (let i = 0; i < 4; i++) s.ingest(chat(`c${i}`, `m${i}`));
    expect(s.recentContext()).toEqual(['乙（弹幕）: m2', '乙（弹幕）: m3']);
  });

  it('puts chat into the agent prompt', async () => {
    const config = cfg();
    const s = makeSession(config);
    s.ingest(REAL_CHAT);
    await answerInMeeting(deps(s, config).args, '总结一下', { deliver: 'caller' });
    const prompt = mocks.startRunFlow.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('张三（弹幕）: @bot 帮我整理一下刚才的结论');
  });
});

describe('summary for meetings without captions', () => {
  it('summarizes a chat-only meeting and says so', async () => {
    const config = cfg();
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.ingest(REAL_CHAT);
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    await summarizeEndedMeeting(d.args);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.to).toBe('oc_team');
    expect(d.sent[0]!.markdown).toContain('会议纪要 · 周会');
    expect(d.sent[0]!.markdown).toContain('只基于会中弹幕');
  });

  it('tells the owner when there is nothing to summarize, once', async () => {
    const config = cfg();
    const s = makeSession(config, { originChatId: 'oc_team' });
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    await summarizeEndedMeeting(d.args);
    await summarizeEndedMeeting(d.args);
    await flush();
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.to).toBe('ou_owner');
    expect(d.sent[0]!.markdown).toContain('字幕/转写');
  });

  it('notes a restart that happened mid-meeting', async () => {
    const config = cfg();
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.ingest(transcript('s1', '周五上线'));
    s.resumedAt = new Date(2026, 10, 20, 16, 5).getTime();
    const d = deps(s, config);
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]!.markdown).toContain('16:05 重启后接回');
    expect(d.sent[0]!.markdown).not.toContain('只基于会中弹幕');
  });

  it('tells the owner when the run produces nothing', async () => {
    mocks.startRunFlow.mockResolvedValue(fakeRun(''));
    const config = cfg();
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.ingest(REAL_CHAT);
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    await summarizeEndedMeeting(d.args);
    await flush();
    expect(d.sent).toEqual([{ to: 'ou_owner', markdown: expect.stringContaining('生成纪要失败') }]);
  });

  it('re-routes the summary to the owner when the origin chat rejects it', async () => {
    const config = cfg();
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.ingest(REAL_CHAT);
    const d = deps(s, config, { botOwnerId: 'ou_owner', failTo: 'oc_team' });
    await summarizeEndedMeeting(d.args);
    await flush();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.to).toBe('ou_owner');
    expect(d.sent[0]!.markdown).toContain('chat disbanded');
    expect(d.sent[0]!.markdown).toContain('结论：周五上线。');
  });
});

describe('failures reach a human', () => {
  it('DMs the owner an answer that could not be posted into the meeting', async () => {
    const config = cfg({ respondIn: 'meeting' });
    // The origin chat may be a group with people who aren't in the meeting.
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.sendMessage = vi.fn(async () => {
      throw new Error('missing vc:meeting.message:write');
    });
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    await answerInMeeting(d.args, '问题', { deliver: 'broadcast' });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.to).toBe('ou_owner');
    expect(d.sent[0]!.markdown).toContain('vc:meeting.message:write');
    expect(d.sent[0]!.markdown).toContain('结论：周五上线。');
  });

  it('does not double-send when respondIn=both already posts to the origin chat', async () => {
    const config = cfg({ respondIn: 'both' });
    const s = makeSession(config, { originChatId: 'oc_team' });
    s.sendMessage = vi.fn(async () => {
      throw new Error('boom');
    });
    const d = deps(s, config);
    await answerInMeeting(d.args, '问题', { deliver: 'broadcast' });
    expect(d.sent).toEqual([{ to: 'oc_team', markdown: '结论：周五上线。' }]);
  });

  it('tells the owner once when polling keeps failing, and re-arms after a success', async () => {
    vi.useFakeTimers();
    let failing = true;
    const client: VcRequestClient = {
      request: vi.fn(async () =>
        (failing
          ? { code: 99991400, msg: 'request trigger frequency limit' }
          : { code: 0, data: { events: [] } }) as never,
      ),
    };
    const config = cfg({ pollIntervalMs: 10 });
    const s = makeSession(config, { client });
    const d = deps(s, config, { botOwnerId: 'ou_owner' });
    attachMeetingAgent(d.args);
    const onTrouble = vi.fn(s.onTrouble);
    s.onTrouble = onTrouble;
    s.startPolling();
    await vi.advanceTimersByTimeAsync(1_000 * (POLL_FAILURE_ALERT + 3));
    expect(onTrouble).toHaveBeenCalledTimes(1);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.markdown).toContain('request trigger frequency limit');
    failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    failing = true;
    await vi.advanceTimersByTimeAsync(1_000 * (POLL_FAILURE_ALERT + 3));
    expect(onTrouble).toHaveBeenCalledTimes(2);
    expect(d.sent).toHaveLength(1); // one DM per meeting per kind
    s.markEnded();
    vi.useRealTimers();
  });
});
