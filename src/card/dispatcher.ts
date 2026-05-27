import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { isChatAllowed, isUserAllowed } from '../config/schema';
import { log } from '../core/logger';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

const AGENT_CALLBACK_MARKERS = ['__agent_cb', '__claude_cb', '__codex_cb'] as const;

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  // Access control. Operator must be on the same allowlists as message
  // senders. Silent drop — sending a denial card to an unauthorized user
  // just confirms the bot exists.
  if (!isUserAllowed(deps.controls.cfg, operatorId)) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
    });
    return;
  }
  // `allowedChats` is group-only — see intakeMessage in bot/channel.ts for
  // the rationale (p2p chat_ids aren't a meaningful access boundary, the
  // user check above is authoritative for DMs).
  if (mode !== 'p2p' && !isChatAllowed(deps.controls.cfg, chatId)) {
    log.info('cardAction', 'skip-not-allowed-chat', {
      chatId: chatId.slice(-6),
    });
    return;
  }

  const callbackMarker = findAgentCallbackMarker(payload);
  if (callbackMarker) {
    forwardToAgent(deps, payload, callbackMarker, formValue, scope, threadId);
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (!cmd) return;
  log.info('cardAction', 'cmd', { cmd, scope });

  const ctx: CommandContext = {
    channel: deps.channel,
    msg: makeFakeMsg(deps.evt, threadId),
    scope,
    chatMode: mode,
    sessions: deps.sessions,
    workspaces: deps.workspaces,
    activeRuns: deps.activeRuns,
    agent: deps.agent,
    controls: deps.controls,
    formValue,
    fromCardAction: true,
  };

  const [name, ...rest] = cmd.split('.');
  const sub = rest.join(' ');
  const args = composeArgs(sub, payload);

  try {
    const ok = await runCommandHandler(name ?? '', args, ctx);
    if (!ok) log.warn('cardAction', 'unknown', { cmd });
  } catch (err) {
    log.fail('cardAction', err, { cmd });
  }
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const r = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    })) as { data?: { items?: { thread_id?: string }[] } };
    return r?.data?.items?.[0]?.thread_id;
  } catch (err) {
    log.warn('cardAction', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function findAgentCallbackMarker(payload: Record<string, unknown>): string | undefined {
  return AGENT_CALLBACK_MARKERS.find((marker) => marker in payload);
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  marker: string,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const { [marker]: _marker, ...agentPayload } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
