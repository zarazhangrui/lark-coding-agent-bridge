import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ startRunFlow: vi.fn() }));

vi.mock('../../../src/bot/run-flow', () => ({ startRunFlow: mocks.startRunFlow }));

const { summarizeEndedMeeting, resolveSummaryTarget } = await import(
  '../../../src/meeting/orchestrator'
);
const { MeetingSession } = await import('../../../src/meeting/session');
const { MEETING_DEFAULTS, createDefaultProfileConfig } = await import(
  '../../../src/config/profile-schema'
);

/** A real ProfileConfig — capability resolution reads more than `agentKind`. */
function profileConfig(meeting: MeetingConfig) {
  const pc = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  pc.meeting = meeting;
  return pc;
}

import type { MeetingConfig } from '../../../src/config/profile-schema';
import type { VcRequestClient } from '../../../src/meeting/api';

const noopClient: VcRequestClient = { request: vi.fn(async () => ({ code: 0, data: {} }) as never) };

/** A run that emits one text chunk then completes. */
function fakeRun(text: string) {
  return {
    ok: true as const,
    execution: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', delta: text };
          yield { type: 'done' };
        },
      }),
    },
    policy: {},
    cwdRealpath: '/repo',
  };
}

function makeSession(config: MeetingConfig, originChatId?: string) {
  const s = new MeetingSession({
    client: noopClient,
    meetingId: '70001',
    meetingNo: '123456789',
    topic: '周会',
    config,
    ...(originChatId ? { originChatId } : {}),
  });
  s.ingest({
    event_id: 'e1',
    activity_event_type: 'transcript_received',
    transcript_received_items: [{ sentence_id: 1, text: '讨论了发布计划', speaker: { name: '甲' } }],
  });
  return s;
}

function deps(config: MeetingConfig, originChatId?: string, botOwnerId?: string) {
  const sent: { to: string; input: unknown }[] = [];
  const session = makeSession(config, originChatId);
  return {
    sent,
    session,
    args: {
      session,
      channel: {
        send: vi.fn(async (to: string, input: unknown) => {
          sent.push({ to, input });
          return {} as never;
        }),
      },
      controls: {
        profile: 'claude',
        profileConfig: profileConfig(config),
        ...(botOwnerId ? { botOwnerId } : {}),
      },
      executor: {},
      activeRuns: { interrupt: vi.fn() },
      sessions: {},
      workspaces: {},
    } as never,
  };
}

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return { ...MEETING_DEFAULTS, enabled: true, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startRunFlow.mockResolvedValue(fakeRun('讨论了发布计划；结论：周五上线。'));
});

describe('summarizeEndedMeeting', () => {
  it('does nothing when summaryOnEnd is off', async () => {
    const d = deps(cfg({ summaryOnEnd: false }), 'oc_team');
    await summarizeEndedMeeting(d.args);
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('summarizes to the chat the meeting was joined from', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), 'oc_team');
    await summarizeEndedMeeting(d.args);

    expect(mocks.startRunFlow).toHaveBeenCalledTimes(1);
    expect(mocks.startRunFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: {
          kind: 'unavailable',
          reason: 'meeting-does-not-support-interactive-turns',
        },
      }),
    );
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]?.to).toBe('oc_team');
    expect(String((d.sent[0]?.input as { markdown: string }).markdown)).toContain('会议纪要 · 周会');
    expect(String((d.sent[0]?.input as { markdown: string }).markdown)).toContain('周五上线');
  });

  it('falls back to the bot owner DM when there is no origin chat (console join)', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), undefined, 'ou_owner');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('ou_owner');
  });

  it('honours summaryTarget=owner even when an origin chat exists', async () => {
    const d = deps(cfg({ summaryOnEnd: true, summaryTarget: 'owner' }), 'oc_team', 'ou_owner');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('ou_owner');
  });

  it('falls back from owner to the origin chat when the owner is unknown', async () => {
    const d = deps(cfg({ summaryOnEnd: true, summaryTarget: 'owner' }), 'oc_team');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('oc_team');
  });

  it('skips when there is nowhere to send it', async () => {
    const d = deps(cfg({ summaryOnEnd: true }));
    await summarizeEndedMeeting(d.args);
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('skips an empty meeting instead of summarizing nothing', async () => {
    const config = cfg({ summaryOnEnd: true });
    const session = new MeetingSession({
      client: noopClient,
      meetingId: '70001',
      meetingNo: '123456789',
      config,
      originChatId: 'oc_team',
    });
    const sent: unknown[] = [];
    await summarizeEndedMeeting({
      session,
      channel: { send: vi.fn(async () => { sent.push(1); return {} as never; }) },
      controls: { profile: 'claude', profileConfig: profileConfig(config) },
      executor: {},
      activeRuns: { interrupt: vi.fn() },
      sessions: {},
      workspaces: {},
    } as never);

    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('still works after the meeting ended (transcript survives markEnded)', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), 'oc_team');
    d.session.markEnded(); // what the manager does before invoking onEnded
    await summarizeEndedMeeting(d.args);
    expect(d.sent).toHaveLength(1);
  });
});

describe('resolveSummaryTarget', () => {
  it('prefers the configured target and reports no fallback', () => {
    expect(resolveSummaryTarget('origin', 'oc_a', 'ou_b')).toEqual({
      to: 'oc_a',
      kind: 'origin',
      fellBack: false,
    });
    expect(resolveSummaryTarget('owner', 'oc_a', 'ou_b')).toEqual({
      to: 'ou_b',
      kind: 'owner',
      fellBack: false,
    });
  });

  it('falls back both directions and flags it', () => {
    expect(resolveSummaryTarget('origin', undefined, 'ou_b')).toEqual({
      to: 'ou_b',
      kind: 'owner',
      fellBack: true,
    });
    expect(resolveSummaryTarget('owner', 'oc_a', undefined)).toEqual({
      to: 'oc_a',
      kind: 'origin',
      fellBack: true,
    });
  });

  it('returns undefined when neither lane exists', () => {
    expect(resolveSummaryTarget('origin', undefined, undefined)).toBeUndefined();
    expect(resolveSummaryTarget('owner', undefined, undefined)).toBeUndefined();
  });
});
