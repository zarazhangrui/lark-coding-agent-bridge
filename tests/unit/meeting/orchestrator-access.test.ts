import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, MEETING_DEFAULTS } from '../../../src/config/profile-schema';
import type { MeetingConfig } from '../../../src/config/profile-schema';

const mocks = vi.hoisted(() => ({ startRunFlow: vi.fn() }));

vi.mock('../../../src/bot/run-flow', () => ({ startRunFlow: mocks.startRunFlow }));

const { attachMeetingAgent, summarizeEndedMeeting } = await import(
  '../../../src/meeting/orchestrator'
);
const { MeetingSession } = await import('../../../src/meeting/session');

const LUMOS_OWNER_OPEN_ID = 'ou_9c50b535153004480e6c305960c4a570';
const noopClient = { request: vi.fn(async () => ({ code: 0, data: {} }) as never) };

function meetingConfig(overrides: Partial<MeetingConfig> = {}): MeetingConfig {
  return {
    ...MEETING_DEFAULTS,
    ...overrides,
    trigger: '@助手',
    transcript: { ...MEETING_DEFAULTS.transcript, ...overrides.transcript },
  };
}

function profileConfig(config: MeetingConfig) {
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
    },
  });
  profile.meeting = config;
  return profile;
}

function session(config: MeetingConfig) {
  return new MeetingSession({
    client: noopClient,
    meetingId: 'meeting-1',
    meetingNo: '123456789',
    config,
  });
}

function chatEvent(senderId: string, content = '@助手 现在进展如何') {
  return {
    event_id: `chat-${senderId}`,
    activity_event_type: 'chat_received',
    chat_received_items: [{ content, message_type: 1, sender: { open_id: senderId } }],
  } as never;
}

function deps(input: {
  profile: string;
  botOwnerId?: string;
  session: InstanceType<typeof MeetingSession>;
  config: MeetingConfig;
}) {
  const sent: string[] = [];
  return {
    sent,
    controls: {
      profile: input.profile,
      profileConfig: profileConfig(input.config),
      ...(input.botOwnerId ? { botOwnerId: input.botOwnerId } : {}),
    },
    deps: {
      session: input.session,
      channel: {
        botIdentity: { name: '助手' },
        send: vi.fn(async (_chatId: string, content: { markdown: string }) => {
          sent.push(content.markdown);
          return {};
        }),
      },
      controls: {
        profile: input.profile,
        profileConfig: profileConfig(input.config),
        ...(input.botOwnerId ? { botOwnerId: input.botOwnerId } : {}),
      },
      executor: {},
      activeRuns: { interrupt: vi.fn(() => false) },
      sessions: {},
      workspaces: {},
    } as never,
  };
}

function fakeRun() {
  return {
    ok: true as const,
    execution: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', delta: 'answer' };
          yield { type: 'done', terminationReason: 'normal' };
        },
      }),
    },
    policy: {},
    cwdRealpath: '/repo',
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Lumos non-IM owner gates', () => {
  it('drops an outsider meeting trigger before transcript or agent work', async () => {
    mocks.startRunFlow.mockResolvedValue(fakeRun());
    const config = meetingConfig();
    const s = session(config);
    const d = deps({ profile: 'lumos', botOwnerId: LUMOS_OWNER_OPEN_ID, session: s, config });
    attachMeetingAgent(d.deps);

    s.ingest(chatEvent('ou_outsider'));
    await Promise.resolve();

    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(d.sent).toEqual([]);
  });

  it('keeps other profiles compatible for an outsider meeting trigger', async () => {
    mocks.startRunFlow.mockResolvedValue(fakeRun());
    const config = meetingConfig();
    const s = session(config);
    const d = deps({ profile: 'claude', botOwnerId: 'ou_owner', session: s, config });
    attachMeetingAgent(d.deps);

    s.ingest(chatEvent('ou_outsider'));
    await vi.waitFor(() => expect(mocks.startRunFlow).toHaveBeenCalledTimes(1));
  });

  it('does not summarize a Lumos meeting when the resolved owner is not Wan', async () => {
    const config = meetingConfig({ summaryOnEnd: true });
    const s = session(config);
    s.ingest({
      event_id: 'transcript-1',
      activity_event_type: 'transcript_received',
      transcript_received_items: [{ sentence_id: 1, text: 'secret context', speaker: { name: '甲' } }],
    } as never);
    const d = deps({ profile: 'lumos', botOwnerId: 'ou_outsider', session: s, config });

    await summarizeEndedMeeting(d.deps);

    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(d.sent).toEqual([]);
  });
});
