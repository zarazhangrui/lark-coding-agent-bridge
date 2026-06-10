import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommentEvent } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface FakeCommentChannel {
  botIdentity?: { openId: string };
  calls: string[];
  replies: string[];
  comments: ReturnType<typeof makeFakeCommentSurface>;
  rawClient: {
    request(input: unknown): Promise<unknown>;
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

describe('comment guard', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs mentioned comments without comment gates, allowlist, bindings, or IM access', async () => {
    const h = await createHarness({
      comments: {},
      allowedUsers: [],
    });

    await handleCommentMention(h.deps(event({ operator: { openId: 'ou-outsider' } })));

    expect(h.channel.calls).toContain('fileComment.get');
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.channel.replies).toEqual(['answer']);
  });

  it('skips unmentioned, unsupported, and self-reply comments before remote fetch', async () => {
    const h = await createHarness({
      botOpenId: 'ou-bot',
      comments: {},
      allowedUsers: [],
    });

    await handleCommentMention(h.deps(event({ mentionedBot: false })));
    await handleCommentMention(h.deps(event({ fileType: 'bitable' })));
    await handleCommentMention(h.deps(event({ operator: { openId: 'ou-bot' } })));

    expect(h.channel.calls).toEqual([]);
    expect(h.agent.runOptions).toEqual([]);
  });

  it('resolves wiki nodes and falls back to the event token when wiki lookup misses', async () => {
    const h = await createHarness({
      comments: {},
      allowedUsers: [],
      wikiNode: { objToken: 'doc-token', objType: 'docx', spaceId: 'space-1' },
    });

    await handleCommentMention(h.deps(event({ fileToken: 'wiki-node-token' })));

    expect(h.channel.calls).toContain('wiki.getNode');
    expect(h.agent.runOptions[0]?.prompt).toContain('file_token：doc-token');

    const passthrough = await createHarness({
      comments: {},
      allowedUsers: [],
    });

    await handleCommentMention(passthrough.deps(event()));

    expect(passthrough.channel.calls).toContain('wiki.getNode');
    expect(passthrough.agent.runOptions[0]?.prompt).toContain('file_token：doc-token');
  });
});

async function createHarness(options: {
  comments: unknown;
  allowedUsers: string[];
  botOpenId?: string;
  wikiNode?: { objToken: string; objType: string; spaceId?: string };
}): Promise<{
  tmp: TmpProfile;
  channel: FakeCommentChannel;
  agent: FakeAgentAdapter;
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('comment-guard-');
  const calls: string[] = [];
  const replies: string[] = [];
  const rawClient: FakeCommentChannel['rawClient'] = {
      async request(input) {
        calls.push('request');
        const url = (input as { url?: string }).url ?? '';
        if (url.includes('/comments/reaction')) return {};
        if (url.includes('/replies?')) replies.push(extractReplyText(input));
        return {};
      },
      wiki: {
        v2: {
          space: {
            async getNode() {
              calls.push('wiki.getNode');
              if (options.wikiNode) {
                return {
                  data: {
                    node: {
                      obj_token: options.wikiNode.objToken,
                      obj_type: options.wikiNode.objType,
                      space_id: options.wikiNode.spaceId,
                    },
                  },
                };
              }
              throw apiError(131005);
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            async get() {
              calls.push('fileComment.get');
              return commentGet('reply-1', '@bot question');
            },
            async list() {
              calls.push('fileComment.list');
              return { data: { items: [] } };
            },
            async create() {
              calls.push('fileComment.create');
              return {};
            },
          },
        },
      },
  };
  const channel: FakeCommentChannel = {
    calls,
    replies,
    ...(options.botOpenId ? { botIdentity: { openId: options.botOpenId } } : {}),
    rawClient,
    comments: makeFakeCommentSurface(rawClient),
  };
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'answer' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const profileConfig = profile(options.allowedUsers, tmp.workspace, options.comments);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns,
    createRunId: () => 'comment-run-1',
  });

  return {
    tmp,
    channel,
    agent,
    deps: (evt) => ({
      channel: channel as unknown as Parameters<typeof handleCommentMention>[0]['channel'],
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

function profile(
  allowedUsers: string[],
  defaultWorkspace: string,
  comments: unknown,
): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  config.comments = comments as ProfileConfig['comments'];
  config.workspaces.default = defaultWorkspace;
  return config;
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

function apiError(code: number): Error {
  const err = new Error(`api ${code}`) as Error & { response: { data: { code: number } } };
  err.response = { data: { code } };
  return err;
}

function extractReplyText(input: unknown): string {
  const data = input as {
    content?: { elements?: Array<{ text_run?: { text?: string } }> };
    data?: { content?: { elements?: Array<{ text_run?: { text?: string } }> } };
  };
  return data.content?.elements?.[0]?.text_run?.text ?? data.data?.content?.elements?.[0]?.text_run?.text ?? '';
}
