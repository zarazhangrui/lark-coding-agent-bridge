import type { CardActionEvent } from '@larksuite/channel';
import { realpath, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { CallbackRegistryStore } from '../../../src/card/callback-registry.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('原 run 已结束时仍将已绑定卡片的选择送回会话，且不泄漏 callback id', async () => {
    const h = await createHarness();
    const token = await h.registry.beginRun({
      runId: 'run-finished', scope: 'oc_group', chatId: 'oc_group',
      operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session',
    });
    const registration = await h.registry.register(token, {
      schema: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] },
    });
    await h.registry.bind(token, registration.id, 'om_card');
    await h.registry.endRun(token);

    await h.dispatch({ __bridge_cb: true, callback_id: registration.id, choice: 'a' });

    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual([
      '[card-click] {"choice":"a"}',
    ]);
  });

  it('校验并转发 SDK 规范化的数值、布尔值和多选表单', async () => {
    const h = await createHarness();
    const id = await registerCallback(h, {
      type: 'object', properties: {
        form_value: { type: 'object', properties: {
          amount: { type: 'number' }, approved: { type: 'boolean' },
          choices: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 },
        }, required: ['amount', 'approved', 'choices'] },
      }, required: ['form_value'],
    });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, undefined, {
      action: { tag: 'button', value: { __bridge_cb: true, callback_id: id }, formValue: { amount: 12, approved: true, choices: ['a'] } },
    });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe(
      '[card-click] {"form_value":{"amount":12,"approved":true,"choices":["a"]}}',
    );
  });

  it('多个实例同时收到同一 callback 时，只入队一次，重放仍被拒绝', async () => {
    const h = await createHarness();
    const other = await createHarness({ registryPath: `${h.tmp.profile}/callback-registry.json` });
    const id = await registerCallback(h);
    const payload = { __bridge_cb: true, callback_id: id, choice: 'a' };
    await Promise.all([h.dispatch(payload), other.dispatch(payload)]);
    const queued = [...h.pending.cancel('oc_group'), ...other.pending.cancel('oc_group')];
    expect(queued).toHaveLength(1);
    await h.dispatch(payload);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('不同 callback 携带重复的平台 event_id 时不会重复入队', async () => {
    const h = await createHarness();
    const first = await registerCallback(h);
    const second = await registerCallback(h);
    const raw = { header: { event_id: 'event-shared' } };
    await h.dispatch({ __bridge_cb: true, callback_id: first, choice: 'a' }, undefined, { raw });
    await h.dispatch({ __bridge_cb: true, callback_id: second, choice: 'b' }, undefined, { raw });
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['[card-click] {"choice":"a"}']);
  });

  it.each([
    { messageId: 'om_copied_card' },
    { chatId: 'oc_other' },
    { operator: { openId: 'ou_other' } },
  ])('拒绝来源消息、chat 或操作者不符的点击：%j', async (evt) => {
    const h = await createHarness();
    const id = await registerCallback(h);
    await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' }, undefined, evt);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('策略指纹更新后拒绝旧登记', async () => {
    const h = await createHarness({ fingerprint: 'fp-changed' });
    const id = await registerCallback(h);
    await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it.each([{ choice: 'unknown' }, { choice: 1 }, { choice: 'a', extra: true }, { choice: 'a', cmd: 'stop' }])(
    '拒绝不符合 schema 的数据且不消耗合法登记：%j', async (data) => {
      const h = await createHarness();
      const id = await registerCallback(h);
      await h.dispatch({ __bridge_cb: true, callback_id: id, ...data });
      expect(h.pending.cancel('oc_group')).toEqual([]);
      await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
      expect(h.pending.cancel('oc_group')).toHaveLength(1);
    },
  );

  it('未绑定消息和过期的登记都不入队', async () => {
    let now = 1000;
    const h = await createHarness({ now: () => now });
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} }, ttlSeconds: 1 });
    await h.dispatch({ __bridge_cb: true, callback_id: registration.id });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await h.registry.bind(token, registration.id, 'om_card');
    now = 2000;
    await h.dispatch({ __bridge_cb: true, callback_id: registration.id });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('无效 token 和伪造 callback_id 不能触发内置命令', async () => {
    const h = await createHarness();
    const run = h.agent.run({ runId: 'run-active', prompt: '' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', run);
    await h.dispatch({ __bridge_cb: true, callback_id: {}, bridge_token: 'invalid-token', cmd: 'stop' });
    expect(run.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('登记文件损坏时拒绝回调而非放行或重新生成授权', async () => {
    const h = await createHarness();
    const id = await registerCallback(h);
    await writeFile(`${h.tmp.profile}/callback-registry.json`, '{"version":1,"runs":[],"registrations":[],"events":{}}');
    await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('话题卡片在原 run 结束后只进入来源话题的会话', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group:th_topic', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} } });
    await h.registry.bind(token, registration.id, 'om_card');
    await h.registry.endRun(token);
    await h.dispatch({ __bridge_cb: true, callback_id: registration.id });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    expect(h.pending.cancel('oc_group:th_topic')).toHaveLength(1);
  });

  it('表单不符合登记 schema 时不消费 id，展示卡不触发回调', async () => {
    const h = await createHarness();
    const id = await registerCallback(h, {
      type: 'object', properties: { form_value: { type: 'object', properties: { note: { type: 'string', maxLength: 20 } }, required: ['note'] } }, required: ['form_value'],
    });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 1 });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 'yes', unexpected: 'data' });
    await h.dispatch({ choice: '展示卡' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 'yes' });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe('[card-click] {"form_value":{"note":"yes"}}');
  });

  it('清空或切换 session 后，旧卡不能进入新会话', async () => {
    const h = await createHarness();
    const id = await registerCallback(h);
    h.sessions.clear('oc_group');
    await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    h.sessions.set('oc_group', 'different-session', await realpath(h.tmp.workspace));
    await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('有效旧 token 的业务 callback_id 字段不会被新 registry 路由拦截', async () => {
    const h = await createHarness();
    h.activeRuns.register('oc_group', h.agent.run({ runId: 'run-active', prompt: 'running' }));
    await h.dispatch({ __bridge_cb: true, bridge_token: h.token('agent_callback'), callback_id: 'business-id', choice: 'a' });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe('[card-click] {"callback_id":"business-id","choice":"a"}');
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  registry: CallbackRegistryStore;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>, evt?: Partial<CardActionEvent>): Promise<void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic'; registryPath?: string; fingerprint?: string; now?: () => number } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const workspaceRealpath = await realpath(tmp.workspace);
  sessions.set('oc_group', 'callback-session', workspaceRealpath);
  sessions.set('oc_group:th_topic', 'callback-session', workspaceRealpath);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const registry = new CallbackRegistryStore(opts.registryPath ?? `${tmp.profile}/callback-registry.json`, opts.now);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  controls.profileConfig.workspaces.default = tmp.workspace;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush(), registry.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    registry,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue, evt = {}) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: { ...cardEvent(value, formValue), ...evt },
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackRegistry: registry,
        callbackPolicyFingerprint: opts.fingerprint ?? 'fp-1',
      }),
  };
}

async function registerCallback(h: Harness, schema: unknown = {
  type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'],
}): Promise<string> {
  const token = await h.registry.beginRun({
    runId: 'run-source', scope: 'oc_group', chatId: 'oc_group',
    operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session',
  });
  const registration = await h.registry.register(token, { schema });
  await h.registry.bind(token, registration.id, 'om_card');
  await h.registry.endRun(token);
  return registration.id;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
