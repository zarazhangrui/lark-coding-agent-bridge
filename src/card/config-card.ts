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
  /** Chats the bot is currently a member of — populates the group picker. */
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
 * CardKit 2.0 person picker. Renders the current `default_value` as person
 * pills (with avatar + name + click-to-jump-to-profile, all native Lark
 * client behavior) and lets the user search the directory to add more.
 * Removing a selection is done by clicking the X on the pill — no extra
 * button required.
 *
 * Requires the bot to have `contact:user.base:readonly` granted AND the
 * relevant contact directory visibility — without those, the picker
 * still renders but its search returns nothing and existing selections
 * show as bare IDs.
 */
function personPicker(name: string, defaultIds: string[], placeholder: string): object {
  return {
    tag: 'multi_select_person',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    default_value: defaultIds.map((id) => ({ id })),
  };
}

/**
 * `multi_select_static` populated from the bot's joined chat list. Each
 * option's text shows the chat name + a short id suffix for disambiguation.
 */
function chatPicker(
  name: string,
  options: KnownChat[],
  defaultIds: string[],
  placeholder: string,
): object {
  return {
    tag: 'multi_select_static',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    default_value: defaultIds.map((value) => ({ value })),
    options: options.map((c) => ({
      text: {
        tag: 'plain_text',
        content: `${c.name} (…${c.id.slice(-6)})`,
      },
      value: c.id,
    })),
  };
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const noChatsHint =
    opts.knownChats.length === 0
      ? '\n_暂时没有可选的群——bot 还没被拉进任何群，或群列表还在加载。_'
      : '';

  const accessElements: object[] = [
    {
      tag: 'markdown',
      content:
        '_控制谁能跟 bot 互动。**留空 = 不响应**_\n\n' +
        '点选择框里的 X 移除一项；要快速加人也可以在群里发 `/invite user @某人` / `/invite admin @某人` / `/invite group`。',
    },
    { tag: 'hr' },
    { tag: 'markdown', content: '**允许私聊的用户**\n_只有这些用户能在私聊里找 bot。_' },
    personPicker('allowed_users_picker', opts.allowedUsers, '输入姓名 / 邮箱 / 手机号搜索'),
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**允许响应的群**\n_bot 只在这些群里响应（含话题群）。_${noChatsHint}`,
    },
    chatPicker('allowed_chats_picker', opts.knownChats, opts.allowedChats, '从 bot 所在的群里选'),
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        '**管理员**\n' +
        '_可以跑敏感命令：`/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite`。管理员也自动获得私聊权限。_',
    },
    personPicker('admins_picker', opts.admins, '输入姓名 / 邮箱 / 手机号搜索'),
  ];

  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **偏好设置**\n\n' +
            '调整 bot 的行为偏好。改完点提交，**立即生效**（无需重启）并写入 `~/.lark-channel/config.json`。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**消息回复方式**\n' +
                '_纯文本：agent 跑完一次性发出，不流式，体感最轻_\n' +
                '_消息卡片：轻量流式 markdown 卡片，飞书原生打字机动画_',
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
                { text: { tag: 'plain_text', content: '纯文本' }, value: 'text' },
                { text: { tag: 'plain_text', content: '消息卡片（默认）' }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**工具调用显示**\n' +
                '_显示：可以看到 bot 跑了什么命令、读了哪些文件等过程_\n' +
                '_隐藏：只看 agent 最终的文字答复，跳过所有工具块_',
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: '显示（默认）' }, value: 'show' },
                { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**并发上限**\n' +
                '_全局同时运行的 agent 进程数（主要影响话题群多话题并行场景）_\n' +
                '_默认 10，范围 1-50。超出的请求会 FIFO 排队_',
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
                '\n**run 探活（分钟）**\n' +
                '_agent 长时间没输出时自动 kill，防止假死_\n' +
                '_0 = 关闭（默认），范围 1-120。可被 `/timeout` 在单个 scope 覆盖_',
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
                '\n**群里需要 @ bot**\n' +
                '_是（默认）：群和话题群里，不 @ bot 的消息不会触发回复_\n' +
                '_否：任何消息都会发给 agent（0.1.21 及更早版本的行为）_\n' +
                '_私聊永远不需要 @；`@全员` 永远不响应_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是（默认）' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            { tag: 'hr' },
            collapsedAccessPanel('🔒 **访问控制**（点击展开）', accessElements),
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
                      text: { tag: 'plain_text', content: '提交' },
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
                      text: { tag: 'plain_text', content: '取消' },
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
      ? '交互卡片'
      : opts.messageReply === 'markdown'
        ? '消息卡片'
        : '纯文本';
  const summarize = (list: string[]): string =>
    list.length === 0 ? '_(空)_' : `${list.length} 项`;
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **偏好已保存**\n\n' +
            `**消息回复方式**：${replyLabel}\n` +
            `**工具调用显示**：\`${opts.showToolCalls ? 'show' : 'hide'}\`\n` +
            `**并发上限**：\`${opts.maxConcurrentRuns}\`\n` +
            `**run 探活**：\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}\`\n` +
            `**群里需要 @ bot**：\`${opts.requireMentionInGroup ? '是' : '否'}\`\n\n` +
            '🔒 **访问控制**\n' +
            `**允许私聊的用户**：${summarize(opts.allowedUsers)}\n` +
            `**允许响应的群**：${summarize(opts.allowedChats)}\n` +
            `**管理员**：${summarize(opts.admins)}\n\n` +
            '下条消息开始生效。',
        },
      ],
    },
  };
}

/**
 * Card shown when the operator runs `/config` but the bot is missing one
 * or more required scopes. The button opens Lark's scope-apply page —
 * once granted, re-running /config falls through to the real form.
 */
export function scopeRequiredCard(opts: {
  missingScopes: string[];
  applyUrl: string;
}): object {
  const list = opts.missingScopes.map((s) => `\`${s}\``).join('、');
  return {
    schema: '2.0',
    config: { summary: { content: '权限不足，需要去授权' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '🔐 **需要授权后才能继续**\n\n' +
            `Bot 缺少以下权限：${list}\n\n` +
            '点下方按钮在浏览器里一键申请，授权完成后**重新发 `/config`** 即可。',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔐 去一键授权' },
          type: 'primary',
          behaviors: [{ type: 'open_url', default_url: opts.applyUrl }],
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }],
    },
  };
}
