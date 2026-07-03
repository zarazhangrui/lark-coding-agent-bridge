import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommentEvent } from '@larksuite/channel';
import type { AgentEvent } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { commentTokenDigest } from '../../../src/bot/comment-resource.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RequestRecord {
  method: string;
  url: string;
  data?: unknown;
}

interface FakeCommentChannel {
  requests: RequestRecord[];
  comments: ReturnType<typeof makeFakeCommentSurface>;
  rawClient: {
    request(input: RequestRecord): Promise<unknown>;
    wiki: { v2: { space: { getNode(input: unknown): Promise<unknown> } } };
    drive: {
      v1: {
        fileComment: {
          get(input: { path: { comment_id: string } }): Promise<unknown>;
          list(input: unknown): Promise<unknown>;
          create(input: unknown): Promise<unknown>;
        };
      };
    };
  };
}

const cleanups: Array<() => Promise<void>> = [];

describe('pi cloud-doc comment regression', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shares pi sessions across different comment threads in the same document', async () => {
    const h = await createHarness({
      agentTexts: ['first answer', 'second answer', 'third answer'],
      sessionIds: ['session-one', 'session-two', 'session-three'],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-2', replyId: 'reply-2' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(3);
    expect(h.agent.runOptions[0]?.sessionId).toBeUndefined();
    expect(h.agent.runOptions[1]?.sessionId).toBe('session-one');
    expect(h.agent.runOptions[2]?.sessionId).toBe('session-two');
    expect(h.sessions.resumeFor(docSessionScope('doc-token'), await realpath(h.tmp.workspace))).toBe(
      'session-three',
    );
    expect(h.sessions.resumeFor('doc:doc-token', await realpath(h.tmp.workspace))).toBeUndefined();
  });

  it('captures a fresh pi run system-event sessionId into the legacy sessions store', async () => {
    const h = await createHarness({
      agentTexts: ['only answer'],
      sessionIds: ['fresh-session'],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.sessionId).toBeUndefined();
    expect(h.sessions.resumeFor(docSessionScope('doc-token'), await realpath(h.tmp.workspace))).toBe(
      'fresh-session',
    );
  });
});

async function createHarness(options: {
  agentTexts?: string[];
  sessionIds?: string[];
} = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
  inThreadReplies: string[];
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('pi-comment-run-flow-');
  const requests: RequestRecord[] = [];
  const inThreadReplies: string[] = [];
  const agentTexts = options.agentTexts ?? ['answer one'];
  const sessionIds = options.sessionIds ?? ['session-one'];
  const eventRuns: AgentEvent[][] = agentTexts.map((text, index) => [
    {
      type: 'system',
      sessionId: sessionIds[index] ?? `session-${index}`,
      cwd: tmp.workspace,
    },
    { type: 'text', delta: text },
    {
      type: 'done',
      sessionId: sessionIds[index] ?? `session-${index}`,
      terminationReason: 'normal',
    },
  ]);
  const agent = new FakeAgentAdapter({ events: eventRuns });
  const rawClient: FakeCommentChannel['rawClient'] = {
    async request(input) {
      requests.push(input);
      if (input.url.includes('/comments/reaction')) {
        return {};
      }
      if (input.url.includes('/replies?')) {
        inThreadReplies.push(extractText(input.data));
        return {};
      }
      return {};
    },
    wiki: {
      v2: { space: { async getNode() { throw apiError(131005); } } },
    },
    drive: {
      v1: {
        fileComment: {
          async get(input) {
            const commentId = input.path.comment_id;
            const replyId = commentId === 'comment-2' ? 'reply-2' : 'reply-1';
            return commentGet(replyId, '@bot question');
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
    requests,
    rawClient,
    comments: makeFakeCommentSurface(rawClient),
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(docSessionScope('doc-token'), tmp.workspace);
  const profileConfig = profile(tmp.workspace);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns,
    createRunId: () => `comment-run-${agent.runOptions.length + 1}`,
  });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    profileConfig,
    activeRuns,
    executor,
    inThreadReplies,
    deps: (evt) => ({
      channel: channel as unknown as Parameters<typeof handleCommentMention>[0]['channel'],
      evt,
      agent,
      sessions,
      sessionCatalog,
      workspaces,
      activeRuns,
      executor,
      controls: {
        profile: 'pi',
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

function profile(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'pi',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers: ['ou-user'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    pi: { binaryPath: 'pi' },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function docSessionScope(fileToken: string): string {
  return `doc:${commentTokenDigest(fileToken)}`;
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
