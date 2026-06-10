import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommentEvent, NormalizedMessage } from '@larksuite/channel';
import { handleCommentMention } from '../../../src/bot/comments';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('unified access gates', () => {
  it('lets the runtime owner run admin commands even when admins is empty', async () => {
    const root = await makeRoot();
    const channel = createFakeChannel();
    const sessions = new SessionStore(join(root, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
    const controls = makeControls({ owner: 'ou_owner', defaultWorkspace: root });
    const ctx = commandContext({
      channel,
      sessions,
      workspaces,
      controls,
      senderId: 'ou_owner',
      content: `/cd ${root}`,
    });

    await tryHandleCommand(ctx);
    await Promise.all([sessions.flush(), workspaces.flush()]);

    await expect(realpath(root)).resolves.toBe(workspaces.cwdFor('chat-1'));
    expect(lastMarkdown(channel)).toContain('已切换 cwd');
  });

  it('denies directory commands for non-owner users when admins is empty', async () => {
    const root = await makeRoot();
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    const allowed = join(root, 'allowed');
    await mkdir(allowed, { recursive: true });
    const channel = createFakeChannel();
    const sessions = new SessionStore(join(root, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
    const controls = makeControls({ owner: 'ou_owner', defaultWorkspace: allowed });
    const ctx = commandContext({
      channel,
      sessions,
      workspaces,
      controls,
      senderId: 'ou_other',
      content: `/cd ${outside}`,
    });

    await tryHandleCommand(ctx);

    expect(workspaces.cwdFor('chat-1')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('仅管理员可用');
  });

  it('does not apply IM access gates to cloud-doc comment mentions', async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const rawClient = {
      wiki: {
        v2: {
          space: {
            async getNode() {
              calls.push('wiki.getNode');
              return {};
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            async get() {
              calls.push('fileComment.get');
              return {};
            },
            async list() {
              calls.push('fileComment.list');
              return {};
            },
          },
        },
      },
    };
    const channel = {
      rawClient,
      comments: makeFakeCommentSurface(rawClient),
    };
    const agent = new FakeAgentAdapter({ events: [] });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns,
      createRunId: () => 'comment-run-1',
    });

    await handleCommentMention({
      channel: channel as Parameters<typeof handleCommentMention>[0]['channel'],
      evt: commentEvent('ou_other'),
      agent,
      sessions: new SessionStore(join(root, 'sessions.json')),
      workspaces: new WorkspaceStore(join(root, 'workspaces.json')),
      activeRuns,
      executor,
      controls: makeControls({ owner: 'ou_owner' }),
    });

    expect(calls).toEqual(['wiki.getNode', 'fileComment.get']);
  });
});

async function makeRoot(): Promise<string> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(tmpdir(), 'bridge-access-gate-')),
  );
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function makeControls(opts: {
  owner: string;
  access?: Partial<ProfileConfig['access']>;
  defaultWorkspace?: string;
}): Controls {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    access: opts.access,
  });
  if (opts.defaultWorkspace) profileConfig.workspaces.default = opts.defaultWorkspace;
  return {
    profile: 'claude',
    profileConfig,
    botOwnerId: opts.owner,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'self',
    async restart() {},
    async exit() {},
  };
}

function commandContext(args: {
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  senderId: string;
  content: string;
}): CommandContext {
  return {
    channel: args.channel as unknown as CommandContext['channel'],
    msg: message(args.senderId, args.content),
    scope: 'chat-1',
    chatMode: 'p2p',
    sessions: args.sessions,
    workspaces: args.workspaces,
    agent: new FakeAgentAdapter({ events: [] }),
    activeRuns: new ActiveRuns(),
    controls: args.controls,
  };
}

function message(senderId: string, content: string): NormalizedMessage {
  return {
    messageId: 'om-access',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId,
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function commentEvent(senderId: string): CommentEvent {
  return {
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment-1',
    replyId: 'reply-1',
    mentionedBot: true,
    operator: { openId: senderId },
  } as CommentEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}
