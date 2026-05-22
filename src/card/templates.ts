interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置，使用 $HOME)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作空间。点下方按钮新建一个，或发送 `/ws save <name>` 把当前 cwd 存为工作空间。'));
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  // Footer: two distinct entry points — create a brand-new project, or add an
  // existing folder. Both open a button-driven directory browser (no typing).
  elements.push(HR);
  elements.push(
    actions([
      { text: '➕ 新建项目', value: { cmd: 'ws.new' }, style: 'primary' },
      { text: '📁 添加已有', value: { cmd: 'ws.add' } },
    ]),
  );

  return shell('📂 工作空间', elements);
}

/**
 * Compact "console" card — the one that gets pinned / auto-posted. Keeps the
 * pinned message short: a couple of status lines plus entry buttons. The full
 * project list only opens on demand via "切换项目" (→ {@link workspacesCard}).
 */
export function menuCard(current: string | undefined, count: number): object {
  return shell('📂 项目控制台', [
    divMd(
      `点下方按钮切换、新建或添加项目，无需打命令。\n` +
        `_群里跟我说话记得 @ 我；这张卡丢了就发 \`/menu\` 调出。_`,
    ),
    HR,
    divMd(`当前：\`${escapeCode(current ?? '(未设置，使用 $HOME)')}\`\n已保存 ${count} 个项目`),
    HR,
    actions([
      { text: '📂 切换项目', value: { cmd: 'ws.list' }, style: 'primary' },
      { text: '➕ 新建项目', value: { cmd: 'ws.new' } },
      { text: '📁 添加已有', value: { cmd: 'ws.add' } },
      { text: '📊 状态', value: { cmd: 'status' } },
    ]),
  ]);
}

/**
 * Directory browser. Lets the user drill into folders with buttons instead of
 * typing paths. `mode` decides the "pick" action: 'add' binds the current dir
 * as a workspace; 'new' opens the name form to create a project inside it.
 * `parent` is the dir one level up (computed by the caller). `subdirs` is the
 * pre-listed, pre-filtered child directory names.
 *
 * Built on the same legacy card schema as {@link workspacesCard} (sent via
 * channel.send), so navigation is plain recall-and-resend — no CardKit entity
 * updates, which silently reject this button-heavy layout.
 */
export function wsBrowseCard(
  mode: 'add' | 'new',
  dir: string,
  parent: string,
  subdirs: string[],
  truncated: boolean,
): object {
  const browseCmd = mode === 'add' ? 'ws.browseAdd' : 'ws.browseNew';
  const pick: ButtonSpec =
    mode === 'add'
      ? { text: '✅ 添加此目录', value: { cmd: 'ws.bind', arg: dir }, style: 'primary' }
      : { text: '➕ 在此新建项目', value: { cmd: 'ws.newat', arg: dir }, style: 'primary' };
  const title = mode === 'add' ? '📁 添加已有项目' : '➕ 新建项目 · 选父目录';

  const elements: object[] = [
    divMd(`**当前目录**\n\`${escapeCode(dir)}\``),
    HR,
    actions([pick, { text: '⬆️ 上级', value: { cmd: browseCmd, arg: parent } }]),
  ];

  if (subdirs.length > 0) {
    elements.push(divMd('**子目录**（点进入）'));
    for (const name of subdirs) {
      const child = `${dir === '/' ? '' : dir}/${name}`;
      elements.push(actions([{ text: `📂 ${name}`, value: { cmd: browseCmd, arg: child } }]));
    }
    if (truncated) elements.push(divMd('_…子目录较多，仅显示前一部分_'));
  } else {
    elements.push(divMd('_（无子目录，可直接选此目录）_'));
  }

  return shell(title, elements);
}

/**
 * CardKit 2.0 form for naming a new project. The parent directory is already
 * chosen via the browser and carried on the submit button's value, so the
 * user only types the name.
 */
export function wsCreateFormCard(parent: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '新建项目' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '➕ **新建项目**\n\n' +
            `将在 \`${parent}\` 下创建。填项目名后提交，自动建目录、存为工作空间并切换过去。`,
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'ws_new_form',
          elements: [
            { tag: 'markdown', content: '**项目名**\n_作为文件夹名和工作空间名_' },
            {
              tag: 'input',
              name: 'project_name',
              placeholder: { tag: 'plain_text', content: 'my-new-project' },
              input_type: 'text',
            },
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
                      text: { tag: 'plain_text', content: '创建' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'ws.create', arg: parent } }],
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
                      behaviors: [{ type: 'callback', value: { cmd: 'ws.cancel' } }],
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

export function wsCreatedCard(name: string, path: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '项目已创建' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **项目已创建**\n\n' +
            `**工作空间**:\`${name}\`\n` +
            `**目录**:\`${path}\`\n\n` +
            '已切换到此项目（session 已重置）。直接发消息开始干活。',
        },
      ],
    },
  };
}

export function wsBoundCard(name: string, path: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已添加项目' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **已添加项目**\n\n' +
            `**工作空间**:\`${name}\`\n` +
            `**目录**:\`${path}\`\n\n` +
            '已切换到此项目（session 已重置）。',
        },
      ],
    },
  };
}

export function wsCreateCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消，未做任何改动。' }],
    },
  };
}

export interface StatusInfo {
  cwd: string;
  sessionId?: string;
  sessionStale: boolean;
  agentName: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : '(无)';
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `📁 **cwd**: \`${escapeCode(info.cwd)}\``,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  preview: string;
  relTime: string;
  lineCount: number;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${e.sessionId.slice(0, 8)}…\` · ${e.relTime} · ${e.lineCount} 条`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(): object {
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/menu` — 弹出并置顶「项目控制台」卡片（切换/新建项目、状态一键直达）',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>|new` — 工作空间（`/ws` 卡片可点按钮切换/新建项目）',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好（消息回复方式、工具调用显示）',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        '- `/doctor [描述]` — 把日志和描述喂给 Claude 自助诊断',
        '- `/help` — 本帮助',
        '',
        '其他内容直接交给 Claude。',
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
