import { modelLabel, supportedModels } from '../agent/models';
import { t } from '../i18n';
import type { KnownChat } from '../bot/lark-info';
import type { AgentKind, LarkCliIdentityPreset, ProfileMode } from '../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  /** Profile's agent kind — decides which model catalog the picker shows. */
  agentKind: AgentKind;
  /** Deployment mode: 'personal' (default) or 'team'. */
  mode: ProfileMode;
  /** Current model selection (a value from {@link supportedModels}). */
  model: string;
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
  /** URL of the running local web console (supervisor `--web-ui` mode). Shown
   * at the top of the card when present; omitted when no console is running. */
  consoleUrl?: string;
}

function collapsedAccessPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return t('common.emptyList');
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

function chatList(chatIds: string[], knownChats: KnownChat[]): string {
  if (chatIds.length === 0) return t('common.emptyList');
  const nameMap = new Map(knownChats.map((chat) => [chat.id, chat.name]));
  return chatIds
    .map((id) => `- **${nameMap.get(id) ?? t('config.unknownChat')}**（...${id.slice(-6)}）`)
    .join('\n');
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const teamMode = opts.mode === 'team';
  const teamOverrideNote = t('config.form.teamOverrideNote');
  const accessElements: object[] = [
    ...(teamMode
      ? [
          {
            tag: 'markdown',
            content: t('config.form.teamAccessNote'),
          },
          { tag: 'hr' },
        ]
      : []),
    {
      tag: 'markdown',
      content: t('config.form.accessIntro'),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: t('config.form.allowedUsers', {
        n: opts.allowedUsers.length,
        list: atMentionLine(opts.allowedUsers),
      }),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: t('config.form.allowedChats', {
        n: opts.allowedChats.length,
        list: chatList(opts.allowedChats, opts.knownChats),
      }),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: t('config.form.admins', {
        n: opts.admins.length,
        list: atMentionLine(opts.admins),
      }),
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: t('config.form.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t('config.form.title'),
        },
        ...(opts.consoleUrl
          ? [
              {
                tag: 'markdown',
                content: t('config.form.consoleUrl', { url: opts.consoleUrl }),
              },
            ]
          : []),
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content: t('config.form.deployMode'),
            },
            {
              tag: 'select_static',
              name: 'deploy_mode',
              initial_option: opts.mode,
              options: [
                { text: { tag: 'plain_text', content: t('config.form.deployMode.personal') }, value: 'personal' },
                { text: { tag: 'plain_text', content: t('config.form.deployMode.team') }, value: 'team' },
              ],
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content: t('config.form.model'),
            },
            {
              tag: 'select_static',
              name: 'model',
              initial_option: opts.model,
              options: supportedModels(opts.agentKind).map((m) => ({
                text: { tag: 'plain_text', content: m.label },
                value: m.value,
              })),
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content: t('config.form.messageReply'),
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              // 'card' (交互卡片) is hidden from the picker for now; existing
              // configs with `messageReply: 'card'` still work — showConfigForm
              // displays them as 'markdown' in the form, but submitting only
              // overwrites if the user actually picks something.
              initial_option: opts.messageReply === 'card' ? 'markdown' : opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: t('config.form.messageReply.text') }, value: 'text' },
                { text: { tag: 'plain_text', content: t('config.form.messageReply.markdown') }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content: t('config.form.showToolCalls'),
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: t('config.form.showToolCalls.show') }, value: 'show' },
                { text: { tag: 'plain_text', content: t('config.form.showToolCalls.hide') }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content: t('config.form.cotMessages'),
            },
            {
              tag: 'select_static',
              name: 'cot_messages',
              initial_option: opts.cotMessages,
              options: [
                { text: { tag: 'plain_text', content: t('config.form.cot.off') }, value: 'off' },
                { text: { tag: 'plain_text', content: t('config.form.cot.brief') }, value: 'brief' },
                { text: { tag: 'plain_text', content: t('config.form.cot.detailed') }, value: 'detailed' },
              ],
            },
            {
              tag: 'markdown',
              content: t('config.form.maxConcurrentRuns'),
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content: t('config.form.runIdleTimeout'),
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content: t('config.form.requireMention'),
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: t('config.form.requireMention.yes') }, value: 'yes' },
                { text: { tag: 'plain_text', content: t('config.form.requireMention.no') }, value: 'no' },
              ],
            },
            {
              tag: 'markdown',
              content: t('config.form.larkCliIdentity') + (teamMode ? teamOverrideNote : ''),
            },
            {
              tag: 'select_static',
              name: 'lark_cli_identity',
              initial_option: opts.larkCliIdentity,
              options: [
                { text: { tag: 'plain_text', content: t('config.form.identity.botOnly') }, value: 'bot-only' },
                { text: { tag: 'plain_text', content: t('config.form.identity.userDefault') }, value: 'user-default' },
              ],
            },
            { tag: 'hr' },
            collapsedAccessPanel(t('config.form.accessPanelTitle'), accessElements),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: t('config.form.button.submit') },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: t('config.form.button.cancel') },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? t('config.reply.card')
      : opts.messageReply === 'markdown'
        ? t('config.reply.markdown')
        : t('config.reply.text');
  const summarize = (list: string[]): string =>
    list.length === 0 ? t('config.saved.empty') : t('config.saved.items', { n: list.length });
  const cotLabel = cotMessagesLabel(opts.cotMessages);
  return {
    schema: '2.0',
    config: { summary: { content: t('config.saved.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t('config.saved.body', {
            mode: opts.mode === 'team' ? t('config.mode.team') : t('config.mode.personal'),
            model: modelLabel(opts.agentKind, opts.model),
            reply: replyLabel,
            showToolCalls: opts.showToolCalls ? 'show' : 'hide',
            cot: cotLabel,
            maxRuns: opts.maxConcurrentRuns,
            idle:
              opts.runIdleTimeoutMinutes > 0
                ? t('timeout.minutes', { n: opts.runIdleTimeoutMinutes })
                : t('config.form.cot.off'),
            requireMention: opts.requireMentionInGroup ? t('common.yes') : t('common.no'),
            identity:
              opts.mode === 'team'
                ? t('config.saved.identityTeamForced')
                : opts.larkCliIdentity === 'user-default'
                  ? t('config.form.identity.userDefault')
                  : t('config.form.identity.botOnly'),
            teamNote: opts.mode === 'team' ? t('config.saved.teamAccessNote') : '',
            users: summarize(opts.allowedUsers),
            chats: summarize(opts.allowedChats),
            admins: summarize(opts.admins),
          }),
        },
      ],
    },
  };
}

function cotMessagesLabel(value: CotMessagesMode): string {
  if (value === 'brief') return t('config.form.cot.brief');
  if (value === 'detailed') return t('config.form.cot.detailed');
  return t('config.form.cot.off');
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('config.grant.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t('config.grant.body', { expireMins, url }),
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('config.granted.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t('config.granted.body'),
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('config.cancelled.summary') } },
    body: {
      elements: [{ tag: 'markdown', content: t('config.cancelled.body') }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('config.failed.summary') } },
    body: {
      elements: [{ tag: 'markdown', content: t('config.failed.body', { reason }) }],
    },
  };
}
