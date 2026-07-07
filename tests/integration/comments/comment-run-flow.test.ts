import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommentEvent } from '@larksuite/channel';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { commentDocumentScopeId, commentTokenDigest } from '../../../src/bot/comment-resource.js';
import { codexCapability } from '../../../src/agent/capability.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
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

describe('comment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs mentioned comments through RunExecutor with document token prompt', async () => {
    const h = await createHarness();

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.prompt).toContain('file_token：doc-token');
    expect(opts.prompt).toContain(
      'lark-cli docs +fetch --api-version v2 --doc doc-token --doc-format markdown',
    );
    expect(opts.prompt).not.toContain('commentScopeId');
    expect(opts.prompt).not.toContain('docScopeId');
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('includes the prior thread replies as context when @-ed on a later reply', async () => {
    const h = await createHarness({
      commentReplies: [
        { reply_id: 'reply-a', text: '这段方案有个风险' },
        { reply_id: 'reply-b', text: '我觉得可以拆成两步' },
        { reply_id: 'reply-1', text: '@bot 说说你的思考' },
      ],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]!.prompt;
    // the two replies before the @bot reply are surfaced as context
    expect(prompt).toContain('此前的讨论');
    expect(prompt).toContain('这段方案有个风险');
    expect(prompt).toContain('我觉得可以拆成两步');
    // the @bot reply is the question, not duplicated into the prior-discussion list
    expect(prompt).toContain('用户的问题：@bot 说说你的思考');
    const priorBlock = prompt.slice(prompt.indexOf('此前的讨论'), prompt.indexOf('用户的问题'));
    expect(priorBlock).not.toContain('说说你的思考');
  });

  it('shares Claude sessions across different comment threads in the same document', async () => {
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
    expect(h.sessions.resumeFor(docSessionScope('doc-token'), await realpath(h.tmp.workspace))).toBe('session-three');
    expect(h.sessions.resumeFor('doc:doc-token', await realpath(h.tmp.workspace))).toBeUndefined();
  });

  it('shares Codex threads across different comment threads in the same document', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      agentTexts: ['first answer', 'second answer', 'third answer'],
      threadIds: ['thread-one', 'thread-two', 'thread-three'],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-2', replyId: 'reply-2' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(3);
    expect(h.agent.runOptions[0]?.threadId).toBeUndefined();
    expect(h.agent.runOptions[1]?.threadId).toBe('thread-one');
    expect(h.agent.runOptions[2]?.threadId).toBe('thread-two');
  });

  it('keeps Codex pre-tool progress text out of every comment reply', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      agentEventRuns: [
        codexRunWithProgress('thread-one', '我先读取文档再处理。', 'first final'),
        codexRunWithProgress('thread-two', '我继续读取上下文。', 'second final'),
      ],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.inThreadReplies).toEqual(['first final', 'second final']);
  });

  it('does not reuse an existing Codex thread while another document comment run is active', async () => {
    const h = await createBlockingHarness({
      agentKind: 'codex',
      threadIds: ['thread-one', 'thread-two'],
    });
    await seedCodexCatalog(h, 'seed-thread');

    const first = handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));
    await waitFor(() => h.agent.runOptions.length === 1);
    const second = handleCommentMention(h.deps(event({ commentId: 'comment-2', replyId: 'reply-2' })));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[0]?.threadId).toBe('seed-thread');
    expect(h.agent.runOptions[1]?.threadId).toBeUndefined();

    h.agent.finishRun(0);
    h.agent.finishRun(1);
    await Promise.all([first, second]);
  });

  it('keeps replying when typing reaction add fails', async () => {
    const h = await createHarness({ reactionFails: true });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('falls back to the default cwd when the document cwd is stale', async () => {
    const h = await createHarness();
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    const defaultCwd = await realpath(h.tmp.workspace);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(defaultCwd);
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('uses a managed fallback cwd when both document and default cwd are stale', async () => {
    const h = await createHarness();
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));
    h.profileConfig.workspaces.default = join(h.tmp.profile, 'missing-default-workspace');

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    const managedCwd = await realpath(join(`${h.tmp.profile}-workspaces`, 'claude', 'default'));
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(managedCwd);
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('replies without starting the agent only when no cwd fallback can be created', async () => {
    const h = await createHarness();
    await writeFile(`${h.tmp.profile}-workspaces`, 'not a directory');
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));
    h.profileConfig.workspaces.default = join(h.tmp.profile, 'missing-default-workspace');

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toEqual([]);
    expect(h.inThreadReplies.at(-1)).toContain('工作目录不可用');
  });

  it('does not call the agent adapter directly from the comment entrypoint', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../src/bot/comments.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toContain('agent.run(');
  });
});

async function createHarness(options: {
  agentKind?: 'claude' | 'codex';
  agentTexts?: string[];
  agentEventRuns?: AgentEvent[][];
  sessionIds?: string[];
  threadIds?: string[];
  reactionFails?: boolean;
  /** Full reply_list (chronological) returned by fileComment.get for comment-1.
   * Lets a test model a thread with replies preceding the @bot reply. */
  commentReplies?: Array<{ reply_id: string; text: string }>;
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
  const tmp = await createTmpProfile('comment-run-flow-');
  const requests: RequestRecord[] = [];
  const inThreadReplies: string[] = [];
  const agentKind = options.agentKind ?? 'claude';
  const agentTexts = options.agentTexts ?? ['answer one'];
  const sessionIds = options.sessionIds ?? ['session-one'];
  const threadIds = options.threadIds ?? ['thread-one'];
  const eventRuns: AgentEvent[][] =
    options.agentEventRuns ??
    agentTexts.map((text, index) => [
      {
        type: 'system',
        ...(agentKind === 'codex'
          ? { threadId: threadIds[index] ?? `thread-${index}` }
          : { sessionId: sessionIds[index] ?? `session-${index}` }),
        cwd: tmp.workspace,
      },
      { type: 'text', delta: text },
      {
        type: 'done',
        ...(agentKind === 'codex'
          ? { threadId: threadIds[index] ?? `thread-${index}` }
          : { sessionId: sessionIds[index] ?? `session-${index}` }),
        terminationReason: 'normal',
      },
    ]);
  const agent = new FakeAgentAdapter({ events: eventRuns });
  const rawClient: FakeCommentChannel['rawClient'] = {
    async request(input) {
      requests.push(input);
      if (input.url.includes('/comments/reaction')) {
        if (options.reactionFails) throw new Error('reaction failed');
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
            if (options.commentReplies && commentId === 'comment-1') {
              return {
                data: {
                  reply_list: {
                    replies: options.commentReplies.map((r) => ({
                      reply_id: r.reply_id,
                      content: { elements: [{ type: 'text_run', text_run: { text: r.text } }] },
                    })),
                  },
                },
              };
            }
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
  const profileConfig = profile(tmp.workspace, agentKind);
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

async function createBlockingHarness(options: {
  agentKind: 'codex';
  threadIds: string[];
}): Promise<{
  tmp: TmpProfile;
  agent: BlockingAgentAdapter;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('comment-run-flow-blocking-');
  const requests: RequestRecord[] = [];
  const agent = new BlockingAgentAdapter(options.threadIds);
  const rawClient: FakeCommentChannel['rawClient'] = {
    async request(input) {
      requests.push(input);
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
  const profileConfig = profile(tmp.workspace, options.agentKind);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 2),
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
    sessionCatalog,
    workspaces,
    profileConfig,
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

async function seedCodexCatalog(
  h: Awaited<ReturnType<typeof createBlockingHarness>>,
  threadId: string,
): Promise<void> {
  const cwdRealpath = await realpath(h.tmp.workspace);
  const capability = codexCapability(h.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'comment',
      actorId: 'ou-user',
      commentScopeId: docSessionScope('doc-token'),
      resourceBindings: [{ kind: 'doc', id: commentDocumentScopeId('doc-token'), verified: true }],
    },
    attachments: [],
    prompt: '',
    requestedCwd: h.tmp.workspace,
    cwdRealpath,
    access: { ok: true, reason: 'comment-mention' },
    capability,
    profileConfig: h.profileConfig,
    now: Date.now(),
    codexHome: h.profileConfig.codex?.codexHome,
    inheritCodexHome: h.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) throw new Error('failed to seed policy');
  h.sessionCatalog.upsertActive({
    scopeId: docSessionScope('doc-token'),
    agentId: 'codex',
    cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
    threadId,
  });
}

class BlockingAgentAdapter implements AgentAdapter {
  readonly id = 'fake-agent';
  readonly displayName = 'Fake Agent';
  readonly runOptions: AgentRunOptions[] = [];
  private readonly finishers: Array<() => void> = [];

  constructor(private readonly threadIds: string[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const index = this.runOptions.length;
    this.runOptions.push(opts);
    let stopped = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.finishers[index] = finish;
    return {
      runId: opts.runId,
      events: this.events(index, done, () => stopped),
      async stop() {
        stopped = true;
        finish();
      },
      async waitForExit() {
        return true;
      },
    };
  }

  finishRun(index: number): void {
    this.finishers[index]?.();
  }

  private async *events(
    index: number,
    done: Promise<void>,
    isStopped: () => boolean,
  ): AsyncIterable<AgentEvent> {
    yield { type: 'system', threadId: this.threadIds[index] ?? `thread-${index}` };
    yield { type: 'text', delta: `answer ${index}` };
    await done;
    if (!isStopped()) {
      yield {
        type: 'done',
        threadId: this.threadIds[index] ?? `thread-${index}`,
        terminationReason: 'normal',
      };
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function profile(defaultWorkspace: string, agentKind: 'claude' | 'codex' = 'claude'): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers: ['ou-user'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function codexRunWithProgress(threadId: string, progress: string, finalAnswer: string): AgentEvent[] {
  return [
    { type: 'system', threadId },
    { type: 'text', delta: progress },
    {
      type: 'tool_use',
      id: `${threadId}-tool`,
      name: 'command_execution',
      input: { command: 'lark-cli docs +fetch --api-version v2 --doc doc-token --doc-format markdown' },
    },
    { type: 'tool_result', id: `${threadId}-tool`, output: 'doc body', isError: false },
    { type: 'text', delta: finalAnswer },
    { type: 'done', threadId, terminationReason: 'normal' },
  ];
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
