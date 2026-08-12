import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentUserInputRequest } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import {
  CODEX_USER_INPUT_MARKER,
  UserInputRegistry,
} from '../../../src/bot/user-input-registry.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { isManaged } from '../../../src/card/managed.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe('Codex user-input CardKit lifecycle', () => {
  it('maps multiple questions and Other back to original ids without echoing answers', async () => {
    const h = await createHarness({ updateDelayMs: 1 });
    const controller = new AbortController();
    const answerPromise = h.registry.request(registerInput(h.request), controller.signal);
    await waitFor(() => h.channel.sent.length === 1);
    const initialCard = sentCard(h.channel);
    const callback = callbackValue(initialCard);

    expect(JSON.stringify(initialCard)).toContain('A <B>');
    expect(JSON.stringify(initialCard)).toContain('bridge_question_0');
    expect(JSON.stringify(initialCard)).toContain('bridge_other_1');
    await h.registry.handleCardAction({
      interactionId: callback.interaction_id,
      token: callback.bridge_token,
      scope: 'oc_group',
      chatId: 'oc_group',
      operatorOpenId: 'ou_operator',
      activeRunId: 'run-active',
      formValue: {
        bridge_question_0: 'choice_0_0',
        bridge_question_1: 'other_1',
        bridge_other_1: '自定义 <答案> & 内容',
      },
    });

    await expect(answerPromise).resolves.toEqual({
      answers: [
        { questionId: 'first.id', value: 'A <B>' },
        { questionId: 'second/id', value: '自定义 <答案> & 内容' },
      ],
    });
    await waitFor(() => updateCards(h.channel).some((card) => JSON.stringify(card).includes('回答已提交')));
    const terminal = updateCards(h.channel).at(-1);
    expect(JSON.stringify(terminal)).not.toContain('自定义 <答案>');
    expect(JSON.stringify(terminal)).not.toContain('A <B>');
    expect(h.registry.activeCount()).toBe(0);
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('renders a retry form for missing answers and accepts its fresh token', async () => {
    const h = await createHarness({ updateDelayMs: 1 });
    const controller = new AbortController();
    const answerPromise = h.registry.request(registerInput(h.request), controller.signal);
    await waitFor(() => h.channel.sent.length === 1);
    const firstCallback = callbackValue(sentCard(h.channel));

    await h.registry.handleCardAction({
      interactionId: firstCallback.interaction_id,
      token: firstCallback.bridge_token,
      scope: 'oc_group',
      chatId: 'oc_group',
      operatorOpenId: 'ou_operator',
      activeRunId: 'run-active',
      formValue: { bridge_question_0: 'choice_0_1' },
    });

    const retryCard = updateCards(h.channel).at(-1);
    expect(JSON.stringify(retryCard)).toContain('请回答所有问题后再提交');
    expect(isManaged('om_fake_1')).toBe(true);
    const retryCallback = callbackValue(retryCard);
    expect(retryCallback.bridge_token).not.toBe(firstCallback.bridge_token);
    await h.registry.handleCardAction({
      interactionId: retryCallback.interaction_id,
      token: retryCallback.bridge_token,
      scope: 'oc_group',
      chatId: 'oc_group',
      operatorOpenId: 'ou_operator',
      activeRunId: 'run-active',
      formValue: {
        bridge_question_0: 'choice_0_1',
        bridge_question_1: 'choice_1_0',
      },
    });
    await expect(answerPromise).resolves.toEqual({
      answers: [
        { questionId: 'first.id', value: 'C & D' },
        { questionId: 'second/id', value: 'No note' },
      ],
    });
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('rejects wrong context and duplicate submission while preserving one-shot semantics', async () => {
    const h = await createHarness({ updateDelayMs: 1 });
    const controller = new AbortController();
    const answerPromise = h.registry.request(registerInput(singleQuestionRequest()), controller.signal);
    await waitFor(() => h.channel.sent.length === 1);
    const callback = callbackValue(sentCard(h.channel));
    const base = {
      interactionId: callback.interaction_id,
      token: callback.bridge_token,
      scope: 'oc_group',
      chatId: 'oc_group',
      activeRunId: 'run-active',
      formValue: { bridge_question_0: 'choice_0_0' },
    };

    await h.registry.handleCardAction({ ...base, operatorOpenId: 'ou_wrong' });
    expect(h.registry.activeCount()).toBe(1);
    await h.registry.handleCardAction({ ...base, operatorOpenId: 'ou_operator' });
    await expect(answerPromise).resolves.toEqual({
      answers: [{ questionId: 'only', value: 'Continue' }],
    });
    await expect(h.registry.handleCardAction({ ...base, operatorOpenId: 'ou_operator' })).resolves.toBe(true);
    expect(h.registry.activeCount()).toBe(0);
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('cancels atomically and marks the card invalid when the run ends', async () => {
    const h = await createHarness();
    const controller = new AbortController();
    const answerPromise = h.registry.request(registerInput(singleQuestionRequest()), controller.signal);
    await waitFor(() => h.channel.sent.length === 1);

    controller.abort(new Error('运行已停止'));
    await expect(answerPromise).rejects.toThrow('运行已停止');
    await waitFor(() => updateCards(h.channel).some((card) => JSON.stringify(card).includes('请求已失效')));
    expect(h.registry.activeCount()).toBe(0);
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('expires the interaction when its callback token reaches the lifetime', async () => {
    const h = await createHarness({ callbackTtlMs: 20 });
    const controller = new AbortController();
    const answerPromise = h.registry.request(
      registerInput(singleQuestionRequest()),
      controller.signal,
    );
    await waitFor(() => h.channel.sent.length === 1);

    await expect(answerPromise).rejects.toThrow('Codex 用户输入请求已过期');
    await waitFor(() => updateCards(h.channel).some(
      (card) => JSON.stringify(card).includes('请求已失效'),
    ));
    expect(h.registry.activeCount()).toBe(0);
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('does not register or send a card for an already-aborted request', async () => {
    const h = await createHarness();
    const controller = new AbortController();
    controller.abort(new Error('运行已停止'));

    await expect(
      h.registry.request(registerInput(singleQuestionRequest()), controller.signal),
    ).rejects.toThrow('运行已停止');
    expect(h.registry.activeCount()).toBe(0);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('releases a late managed-card mapping when cancellation wins the send race', async () => {
    const h = await createHarness();
    const originalSend = h.channel.send.bind(h.channel);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    h.channel.send = async (...args) => {
      await sendGate;
      return originalSend(...args);
    };
    const controller = new AbortController();
    const answerPromise = h.registry.request(
      registerInput(singleQuestionRequest()),
      controller.signal,
    );

    controller.abort(new Error('发送期间停止'));
    releaseSend();
    await expect(answerPromise).rejects.toThrow('发送期间停止');
    await waitFor(() => updateCards(h.channel).some((card) => JSON.stringify(card).includes('请求已失效')));
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('terminates the request when a retry card update fails', async () => {
    const h = await createHarness();
    const controller = new AbortController();
    const answerPromise = h.registry.request(registerInput(h.request), controller.signal);
    await waitFor(() => h.channel.sent.length === 1);
    const callback = callbackValue(sentCard(h.channel));
    h.channel.updateCardById = async () => {
      throw new Error('card update unavailable');
    };

    await expect(h.registry.handleCardAction({
      interactionId: callback.interaction_id,
      token: callback.bridge_token,
      scope: 'oc_group',
      chatId: 'oc_group',
      operatorOpenId: 'ou_operator',
      activeRunId: 'run-active',
      formValue: { bridge_question_0: 'choice_0_0' },
    })).rejects.toThrow('card update unavailable');
    await expect(answerPromise).rejects.toThrow('更新 Codex 用户输入重试卡片失败');
    await waitFor(() => !isManaged('om_fake_1'));
  });

  it('fails immediately when the input card cannot be sent', async () => {
    const h = await createHarness();
    h.channel.send = async () => {
      throw new Error('card send unavailable');
    };
    const controller = new AbortController();
    await expect(
      h.registry.request(registerInput(singleQuestionRequest()), controller.signal),
    ).rejects.toThrow('card send unavailable');
    expect(h.registry.activeCount()).toBe(0);
  });

  it('uses the carrier thread for submission even while chat mode is still group', async () => {
    const h = await createHarness({
      chatMode: 'group',
      scope: 'oc_group:th_topic',
      updateDelayMs: 1,
    });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    const activeRun = h.agent.run({
      runId: 'run-active',
      prompt: 'running',
      userInput: { kind: 'unavailable', reason: 'caller-does-not-support-interactive-turns' },
    });
    h.activeRuns.register('oc_group:th_topic', activeRun);
    const controller = new AbortController();
    const answerPromise = h.registry.request(
      registerInput(singleQuestionRequest(), 'oc_group:th_topic'),
      controller.signal,
    );
    await waitFor(() => h.channel.sent.length === 1);
    const callback = callbackValue(sentCard(h.channel));

    await handleCardAction({
      channel: h.channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(callback, { bridge_question_0: 'choice_0_0' }),
      sessions: h.sessions,
      workspaces: h.workspaces,
      activeRuns: h.activeRuns,
      agent: h.agent,
      controls: h.controls,
      pending: h.pending,
      chatModeCache: h.chatModeCache,
      callbackAuth: h.auth,
      userInputRegistry: h.registry,
    });

    await expect(answerPromise).resolves.toEqual({
      answers: [{ questionId: 'only', value: 'Continue' }],
    });
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(0);
    await waitFor(() => !isManaged('om_fake_1'));
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  registry: UserInputRegistry;
  auth: CallbackAuth;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  pending: PendingQueue;
  controls: Controls;
  chatModeCache: ChatModeCache;
  request: AgentUserInputRequest;
}

async function createHarness(options: {
  updateDelayMs?: number;
  callbackTtlMs?: number;
  chatMode?: 'p2p' | 'group' | 'topic';
  scope?: string;
} = {}): Promise<Harness> {
  const tmp = await createTmpProfile('user-input-card-test-');
  const channel = createFakeChannel();
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  let nonce = 0;
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'callback-secret' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => `nonce-${++nonce}`,
  });
  const registry = new UserInputRegistry({
    channel: channel as unknown as LarkChannel,
    callbackAuth: auth,
    createInteractionId: () => 'interaction-1',
    submittedUpdateDelayMs: options.updateDelayMs ?? 1000,
    ...(options.callbackTtlMs === undefined ? {} : { callbackTtlMs: options.callbackTtlMs }),
  });
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'] },
  });
  const controls = {
    profile: 'codex',
    profileConfig,
    cfg: profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    processId: 'proc-1',
  } satisfies Controls;
  const chatModeCache = {
    resolve: async () => options.chatMode ?? 'group',
    invalidate: () => {},
  } as unknown as ChatModeCache;
  cleanup.push(async () => {
    registry.cancelAll('测试结束');
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    registry,
    auth,
    sessions,
    workspaces,
    activeRuns,
    agent,
    pending,
    controls,
    chatModeCache,
    request: {
      id: 'request-item',
      questions: [
        {
          id: 'first.id',
          header: '第一题 *特殊*',
          question: '请选择 <环境> & 路径',
          allowOther: false,
          options: [
            { label: 'A <B>', description: '包含 *Markdown*' },
            { label: 'C & D', description: '另一个选项' },
          ],
        },
        {
          id: 'second/id',
          header: '第二题',
          question: '请选择备注',
          allowOther: true,
          options: [{ label: 'No note', description: '不添加备注' }],
        },
      ],
    },
  };
}

function registerInput(request: AgentUserInputRequest, scope = 'oc_group') {
  return {
    runId: 'run-active',
    scope,
    chatId: 'oc_group',
    operatorOpenId: 'ou_operator',
    policyFingerprint: 'fp-1',
    request,
    replyTo: 'om_origin',
    replyInThread: scope.includes(':'),
  };
}

function singleQuestionRequest(): AgentUserInputRequest {
  return {
    id: 'single-request',
    questions: [
      {
        id: 'only',
        header: '确认',
        question: '是否继续？',
        allowOther: false,
        options: [{ label: 'Continue', description: '继续执行' }],
      },
    ],
  };
}

function sentCard(channel: FakeChannel): unknown {
  return (channel.sent[0]?.content as { card?: unknown } | undefined)?.card;
}

function updateCards(channel: FakeChannel): unknown[] {
  return channel.rawClient.requests
    .filter((request) => request.method === 'cardkit.v1.card.update')
    .map((request) => (request.params as { cardJson?: unknown }).cardJson);
}

function callbackValue(card: unknown): {
  [CODEX_USER_INPUT_MARKER]: true;
  interaction_id: string;
  bridge_token: string;
} {
  const found = findRecord(card, (record) => record[CODEX_USER_INPUT_MARKER] === true);
  if (!found || typeof found.interaction_id !== 'string' || typeof found.bridge_token !== 'string') {
    throw new Error('callback value not found');
  }
  return found as {
    [CODEX_USER_INPUT_MARKER]: true;
    interaction_id: string;
    bridge_token: string;
  };
}

function findRecord(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecord(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const child of Object.values(record)) {
    const found = findRecord(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function cardEvent(
  callback: ReturnType<typeof callbackValue>,
  formValue: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value: callback },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: { openId: 'ou_operator', name: 'Operator' },
    raw: { action: { form_value: formValue } },
  } as unknown as CardActionEvent;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
