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

  elements.push(divMd(`Current cwd: \`${escapeCode(current ?? '(not set, using $HOME)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('No named workspaces yet.'));
    elements.push(
      divMd('💡 Send `/ws save <name>` to save the current cwd as a named workspace.'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← current' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: 'Switch here', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: 'Delete', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 Workspaces', elements);
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
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ stale cwd, the next message will start a new session' : ''}`
    : '(none)';
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _(per-topic session)_`
      : `\`${escapeCode(info.scope)}\``;
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `📁 **cwd**: \`${escapeCode(info.cwd)}\``,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
  ];
  return shell('📊 Status', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 New session', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 Resume session', value: { cmd: 'resume' } },
      { text: '📂 Workspaces', value: { cmd: 'ws.list' } },
      { text: '💡 Help', value: { cmd: 'help' } },
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
  elements.push(divMd(`Current cwd: \`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('No previous sessions under this cwd.'));
    return shell('🔁 Resume session', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← current' : '';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${e.sessionId.slice(0, 8)}…\` · ${e.relTime} · ${e.lineCount} msgs`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? 'Already current session' : '▸ Resume this session',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 Resume session', elements);
}

export function helpCard(): object {
  return shell('💡 Help', [
    divMd(
      [
        '**Commands**',
        '',
        '- `/new` `/reset` — clear the current chat\'s session',
        '- `/new chat [name]` — create a new group + fresh session, auto-invites you',
        '- `/resume [N]` — list and resume historical sessions (up to N)',
        '- `/cd <path>` — change working directory (resets the session)',
        '- `/ws list|save <name>|use <name>|remove <name>` — manage workspaces',
        '- `/account` — show the current Lark app; `/account change` to swap appId/secret and reconnect',
        '- `/config` — tweak preferences (reply behavior, tool-call display)',
        '- `/status` — current status',
        '- `/stop` — stop the currently running task (also the ⏹ button at the bottom of the card)',
        '- `/timeout [N|off|default]` — idle-watchdog minutes for this session; `/config` sets the global default',
        '- `/ps` — list all bot processes on this machine; marks the one currently replying',
        '- `/exit <id|#>` — kill a bot process (use `/ps` to look up id/index)',
        '- `/reconnect` — force a WebSocket reconnect (use when the bot stops responding after a flaky network)',
        '- `/doctor [description]` — feed logs + description to Claude for self-diagnosis',
        '- `/help` — this help',
        '',
        'Anything else goes straight to Claude.',
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 Status', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 Resume session', value: { cmd: 'resume' } },
      { text: '📂 Workspaces', value: { cmd: 'ws.list' } },
      { text: '🆕 New session', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
