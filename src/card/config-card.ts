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
  if (openIds.length === 0) return '_（暂无）_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

/**
 * Render a chat_id list as a markdown bulleted list. Lark has no group
 * equivalent of `<at>`, so we resolve names from the cached knownChats
 * (zero extra API calls); unknown ids fall back to a short id suffix.
 */
function chatList(chatIds: string[], known: KnownChat[]): string {
  if (chatIds.length === 0) return '_（暂无）_';
  const nameMap = new Map(known.map((c) => [c.id, c.name]));
  return chatIds
    .map((id) => `- 💬 **${nameMap.get(id) ?? '(未知群)'}**（…${id.slice(-6)}）`)
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
        '_控制谁能跟 bot 互动。**留空 = 不响应**。增删走命令，下面是当前状态。_',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许私聊的用户**（共 ${opts.allowedUsers.length} 人）\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_加 / 删：_ `/invite user @某人`　`/remove user @某人`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许响应的群**（共 ${opts.allowedChats.length} 个）\n` +
        `${chatList(opts.allowedChats, opts.knownChats)}\n\n` +
        '_加 / 删（在目标群里发）：_ `/invite group`　`/remove group`\n' +
        '_一键加全部 bot 所在的群：_ `/invite all group`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**管理员**（共 ${opts.admins.length} 人）\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_可以跑敏感命令：`/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`。管理员也自动获得私聊权限。_\n\n' +
        '_加 / 删：_ `/invite admin @某人`　`/remove admin @某人`',
    },
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
              // 'card' is hidden — existing 'card' configs map to 'markdown' on display.
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

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }],
    },
  };
}
