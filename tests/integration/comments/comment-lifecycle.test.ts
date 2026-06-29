import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommentEvent, LarkChannel } from '@larksuite/channel';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { commentTokenDigest } from '../../../src/bot/comment-resource.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RequestRecord {
  url: string;
  data?: unknown;
}

interface FakeCommentChannel {
  botIdentity: { openId: string; name: string };
  requests: RequestRecord[];
  inThreadReplies: string[];
  comments: ReturnType<typeof makeFakeCommentSurface>;
  rawClient: {
    request(input: RequestRecord): Promise<unknown>;
    wiki: { v2: { space: { getNode(input: unknown): Promise<unknown> } } };
    drive: {
      v1: {
        fileComment: {
          get(input: unknown): Promise<unknown>;
          list(input: unknown): Promise<unknown>;
          create(input: unknown): Promise<unknown>;
        };
      };
    };
  };
}

const cleanups: Array<() => Promise<void>> = [];

describe('comment lifecycle', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('skips comments sent by the bot itself before fetching the body', async () => {
    const h = await createHarness({ autoCompleteAgent: true });

    await handleCommentMention(h.deps(event({ operator: { openId: 'ou-bot' } })));

    expect(h.channel.requests).toEqual([]);
    expect(h.agent.runOptions).toEqual([]);
  });

  it('skips bridge reply metadata before fetching the body', async () => {
    const h = await createHarness({ autoCompleteAgent: true });

    await handleCommentMention(
      h.deps(event({ bridgeReply: true } as Partial<CommentEvent> & { bridgeReply: boolean })),
    );

    expect(h.channel.requests).toEqual([]);
    expect(h.agent.runOptions).toEqual([]);
  });

  it('does not write a stale comment reply after the comment run is interrupted', async () => {
    const h = await createHarness();
    const threadScopeId = commentRunScopeId('doc-token', 'comment-1');

    const running = handleCommentMention(h.deps(event()));
    const scopeId = await waitForActiveCommentScope(h, threadScopeId);

    expect(h.activeRuns.interrupt(scopeId)).toBe(true);
    h.agent.release(0);
    await running;

    expect(h.channel.inThreadReplies).toEqual([]);
  });

  it('allows a second mention to start another run for the same comment thread', async () => {
    const h = await createHarness();
    const threadScopeId = commentRunScopeId('doc-token', 'comment-1');

    const first = handleCommentMention(h.deps(event()));
    await waitForActiveCommentScope(h, threadScopeId);

    const second = handleCommentMention(h.deps(event()));
    await vi.waitFor(() => {
      expect(h.agent.runOptions).toHaveLength(2);
      expect(activeCommentScopes(h, threadScopeId)).toHaveLength(2);
    });
    expect(h.channel.inThreadReplies).toEqual([]);

    h.agent.release(0);
    h.agent.release(1);
    await Promise.all([first, second]);

    expect(h.channel.inThreadReplies).toEqual(['stale answer', 'stale answer']);
  });

  it('does not expire comment runs by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const h = await createHarness();
    const scopeId = commentRunScopeId('doc-token', 'comment-1');

    const running = handleCommentMention(h.deps(event()));
    await waitForActiveCommentScope(h, scopeId);

    vi.setSystemTime(new Date('2026-05-25T13:00:00.000Z'));
    expect(activeCommentScopes(h, scopeId)).toHaveLength(1);
    expect(h.agent.stopped).toBe(false);

    h.agent.release(0);
    await running;

    expect(h.channel.inThreadReplies).toEqual(['stale answer']);
  });

  it('stops and replies when a per-comment timeout expires without another agent event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const h = await createHarness();
    const scopeId = commentRunScopeId('doc-token', 'comment-1');
    h.sessions.setIdleTimeoutMinutes(scopeId, 1);

    const running = handleCommentMention(h.deps(event()));
    await waitForActiveCommentScope(h, scopeId);

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    await running;

    expect(h.agent.stopped).toBe(true);
    expect(h.channel.inThreadReplies).toEqual(['本次评论任务已超时，请重新 @ 我。']);
  });

  it('uses the per-comment timeout override for comment runs with subsequent events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const h = await createHarness();
    const scopeId = commentRunScopeId('doc-token', 'comment-1');
    h.sessions.setIdleTimeoutMinutes(scopeId, 1);

    const running = handleCommentMention(h.deps(event()));
    await waitForActiveCommentScope(h, scopeId);

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    await running;

    expect(h.agent.stopped).toBe(true);
    expect(h.channel.inThreadReplies).toEqual(['本次评论任务已超时，请重新 @ 我。']);
  });

  it('does not expire comment runs when the per-comment timeout override is off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const h = await createHarness();
    const scopeId = commentRunScopeId('doc-token', 'comment-1');
    h.sessions.setIdleTimeoutMinutes(scopeId, 0);

    const running = handleCommentMention(h.deps(event()));
    await waitForActiveCommentScope(h, scopeId);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(activeCommentScopes(h, scopeId)).toHaveLength(1);
    expect(h.agent.stopped).toBe(false);

    h.agent.release(0);
    await running;

    expect(h.channel.inThreadReplies).toEqual(['stale answer']);
  });
});

async function createHarness(options: { autoCompleteAgent?: boolean } = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeCommentChannel;
  agent: BlockingAgentAdapter;
  sessions: SessionStore;
  activeRuns: ActiveRuns;
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('comment-lifecycle-');
  const requests: RequestRecord[] = [];
  const inThreadReplies: string[] = [];
  const rawClient: FakeCommentChannel['rawClient'] = {
      async request(input) {
        requests.push(input);
        if (input.url.includes('/replies?')) {
          inThreadReplies.push(extractText(input.data));
        }
        return {};
      },
      wiki: {
        v2: { space: { async getNode() { throw apiError(131005); } } },
      },
      drive: {
        v1: {
          fileComment: {
            async get() {
              return commentGet('reply-1', '@bot question');
            },
            async list() {
              return { data: { items: [] } };
            },
            async create() {
              return {};
            },
          },
        },
      },
  };
  const channel: FakeCommentChannel = {
    botIdentity: { openId: 'ou-bot', name: 'Bridge Bot' },
    requests,
    inThreadReplies,
    rawClient,
    comments: makeFakeCommentSurface(rawClient),
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('doc:doc-token', tmp.workspace);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const profileConfig = profile(tmp.workspace);
  const activeRuns = new ActiveRuns();
  const agent = new BlockingAgentAdapter(options.autoCompleteAgent === true);
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 2),
    activeRuns,
    createRunId: () => 'comment-run-1',
  });

  return {
    tmp,
    channel,
    agent,
    sessions,
    activeRuns,
    deps: (evt) => ({
      channel: channel as unknown as LarkChannel,
      evt,
      agent,
      sessions,
      workspaces,
      activeRuns,
      executor,
      controls: {
        profile: 'claude',
        profileConfig,
        botOwnerId: 'ou-owner',
        ownerRefreshState: 'ok',
        async refreshOwner() {},
        configPath: join(tmp.profile, 'config.json'),
        cfg: profileConfig,
        processId: 'proc-1',
        async restart() {},
        async exit() {},
      },
    }),
  };
}

class BlockingAgentAdapter implements AgentAdapter {
  readonly id = 'fake-agent';
  readonly displayName = 'Fake Agent';
  readonly runOptions: AgentRunOptions[] = [];
  private releases: Array<(() => void) | undefined> = [];
  private wasStopped = false;

  constructor(private readonly autoComplete: boolean = false) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  get stopped(): boolean {
    return this.wasStopped;
  }

  run(opts: AgentRunOptions): AgentRun {
    const runIndex = this.runOptions.length;
    this.runOptions.push(opts);
    return {
      runId: opts.runId,
      events: this.events(runIndex),
      stop: async () => {
        this.wasStopped = true;
        this.release(runIndex);
      },
      waitForExit: async () => true,
    };
  }

  release(index = 0): void {
    this.releases[index]?.();
  }

  private async *events(runIndex: number): AsyncIterable<AgentEvent> {
    yield { type: 'text', delta: 'stale answer' };
    if (this.autoComplete) {
      yield { type: 'done', terminationReason: 'normal' };
      return;
    }
    await new Promise<void>((resolve) => {
      this.releases[runIndex] = resolve;
    });
    if (!this.wasStopped) {
      yield { type: 'done', terminationReason: 'normal' };
    }
  }
}

async function waitForActiveCommentScope(
  h: { activeRuns: ActiveRuns },
  threadScopeId: string,
): Promise<string> {
  await vi.waitFor(() => expect(activeCommentScopes(h, threadScopeId)).toHaveLength(1));
  return activeCommentScopes(h, threadScopeId)[0]!;
}

function activeCommentScopes(h: { activeRuns: ActiveRuns }, threadScopeId: string): string[] {
  return h.activeRuns.scopes().filter((scope) => scope.startsWith(`${threadScopeId}:`));
}

function profile(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers: ['ou-user', 'ou-bot'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  config.comments = {};
  config.workspaces.default = defaultWorkspace;
  return config;
}

function commentRunScopeId(fileToken: string, commentId: string): string {
  return `comment:${commentTokenDigest(`${fileToken}:${commentId}`)}`;
}

function event(overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment-1',
    replyId: 'reply-1',
    mentionedBot: true,
    operator: { openId: 'ou-user' },
    ...overrides,
  } as CommentEvent;
}

function commentGet(replyId: string, question: string): unknown {
  return {
    data: {
      reply_list: {
        replies: [
          {
            reply_id: replyId,
            content: { elements: [{ type: 'text_run', text_run: { text: question } }] },
          },
        ],
      },
    },
  };
}

function extractText(value: unknown): string {
  const data = value as { content?: { elements?: Array<{ text_run?: { text?: string } }> } };
  return data.content?.elements?.[0]?.text_run?.text ?? '';
}

function apiError(code: number): Error {
  const err = new Error(`api ${code}`) as Error & { response: { data: { code: number } } };
  err.response = { data: { code } };
  return err;
}
