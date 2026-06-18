import type { KnownChat } from '../bot/lark-info';
import type { MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  /** Current DM allowlist open_ids. */
  allowedUsers: string[];
  /** Current group whitelist chat_ids. */
  allowedChats: string[];
  /** Current admin open_ids. */
  admins: string[];
  /** Chats the bot is currently a member of — used to resolve chat_id → name. */
  knownChats: KnownChat[];
}

/** Collapsed-by-default panel wrapper for the access section. */
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

/**
 * Render an open_id list as a markdown line of `<at>` mentions. The Lark
 * client resolves each id to an avatar + name pill (and makes it tap-to-
 * profile) entirely client-side — the bridge doesn't fetch anything.
 */
function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return '_(none)_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

/**
 * Render a chat_id list as a markdown bulleted list. Lark has no group
 * equivalent of `<at>`, so we resolve names from the cached knownChats
 * (zero extra API calls); unknown ids fall back to a short id suffix.
 */
function chatList(chatIds: string[], known: KnownChat[]): string {
  if (chatIds.length === 0) return '_(none)_';
  const nameMap = new Map(known.map((c) => [c.id, c.name]));
  return chatIds
    .map((id) => `- 💬 **${nameMap.get(id) ?? '(unknown group)'}** (…${id.slice(-6)})`)
    .join('\n');
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  // Access section: read-only markdown. All add/remove goes through slash
  // commands (/invite + /remove) — the picker was empirically broken in
  // our environment and removed entirely.
  const accessElements: object[] = [
    {
      tag: 'markdown',
      content:
        '_Controls who can interact with the bot. **Empty = bot ignores everyone.** Add/remove via commands; the lines below show the current state._',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Users allowed to DM** (${opts.allowedUsers.length} total)\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_Add / remove:_ `/invite user @someone`　`/remove user @someone`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Groups where the bot responds** (${opts.allowedChats.length} total)\n` +
        `${chatList(opts.allowedChats, opts.knownChats)}\n\n` +
        '_Add all groups the bot is already in:_ `/invite all group`\n' +
        '_Add / remove (run inside the target group):_ `/invite group`　`/remove group`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Admins** (${opts.admins.length} total)\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_Admins can run sensitive commands: `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`. Admins also get DM access automatically._\n\n' +
        '_Add / remove:_ `/invite admin @someone`　`/remove admin @someone`',
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: 'Preferences' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **Preferences**\n\n' +
            'Tweak the bot\'s behavior. Hit Submit to apply — **takes effect immediately** (no restart) and is written to `~/.lark-channel/config.json`.',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**Reply style**\n' +
                '_Plain text: agent posts a single message after the run finishes — no streaming, lightest feel._\n' +
                '_Message card: streaming markdown card with Lark\'s native typewriter animation._',
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              // 'card' is hidden — existing 'card' configs map to 'markdown' on display.
              initial_option: opts.messageReply === 'card' ? 'markdown' : opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: 'Plain text' }, value: 'text' },
                { text: { tag: 'plain_text', content: 'Message card (default)' }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**Tool-call display**\n' +
                '_Show: see what commands the bot ran, which files it read, etc._\n' +
                '_Hide: only the agent\'s final text reply, skip all tool blocks._',
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: 'Show (default)' }, value: 'show' },
                { text: { tag: 'plain_text', content: 'Hide' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**Max concurrent runs**\n' +
                '_Total agent processes running at once across the bridge (mostly relevant for topic groups with many parallel topics)._\n' +
                '_Default 10, range 1–50. Excess requests queue FIFO._',
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
              content:
                '\n**Run idle watchdog (minutes)**\n' +
                '_Kills the agent automatically if it produces no output for N minutes — guards against hangs._\n' +
                '_0 = disabled (default). Range 1–120. Can be overridden per scope with `/timeout`._',
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
              content:
                '\n**Require `@bot` in groups**\n' +
                '_Yes (default): in groups and topic groups, messages that don\'t `@` the bot are ignored._\n' +
                '_No: every message is sent to the agent (the 0.1.21-and-earlier behavior)._\n' +
                '_DMs never require `@`; `@all` is never answered._',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: 'Yes (default)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: 'No' }, value: 'no' },
              ],
            },
            { tag: 'hr' },
            collapsedAccessPanel('🔒 **Access control** (click to expand)', accessElements),
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
                      text: { tag: 'plain_text', content: 'Submit' },
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
                      text: { tag: 'plain_text', content: 'Cancel' },
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
      ? 'Interactive card'
      : opts.messageReply === 'markdown'
        ? 'Message card'
        : 'Plain text';
  const summarize = (list: string[]): string =>
    list.length === 0 ? '_(empty)_' : `${list.length} entries`;
  return {
    schema: '2.0',
    config: { summary: { content: 'Preferences saved' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **Preferences saved**\n\n' +
            `**Reply style**: ${replyLabel}\n` +
            `**Tool-call display**: \`${opts.showToolCalls ? 'show' : 'hide'}\`\n` +
            `**Max concurrent runs**: \`${opts.maxConcurrentRuns}\`\n` +
            `**Run idle watchdog**: \`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} min` : 'disabled'}\`\n` +
            `**Require @bot in groups**: \`${opts.requireMentionInGroup ? 'yes' : 'no'}\`\n\n` +
            '🔒 **Access control**\n' +
            `**Users allowed to DM**: ${summarize(opts.allowedUsers)}\n` +
            `**Groups where bot responds**: ${summarize(opts.allowedChats)}\n` +
            `**Admins**: ${summarize(opts.admins)}\n\n` +
            'Takes effect on the next message.',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Cancelled' } },
    body: {
      elements: [{ tag: 'markdown', content: 'Cancelled — no changes saved.' }],
    },
  };
}
