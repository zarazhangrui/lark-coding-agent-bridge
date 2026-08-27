import { t } from '../i18n';

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

  elements.push(
    divMd(t('ws.currentCwd', { cwd: `\`${escapeCode(current ?? t('common.notSet'))}\`` })),
  );

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd(t('ws.empty')));
    elements.push(divMd(t('ws.emptyHint')));
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? t('common.currentMarker') : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: t('ws.button.switch'), value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: t('common.button.delete'), value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell(t('ws.title'), elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? t('status.staleCwdWarning') : ''}`
    : (info.emptySessionText ?? t('status.sessionEmptyDefault'));
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` ${t('status.topicScopeSuffix')}`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : t('common.notSet');
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell(t('status.title'), [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: t('common.button.newSession'), value: { cmd: 'new' }, style: 'primary' },
      { text: t('common.button.resume'), value: { cmd: 'resume' } },
      { text: t('ws.title'), value: { cmd: 'ws.list' } },
      { text: t('common.button.help'), value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(t('ws.currentCwd', { cwd: `\`${escapeCode(cwd)}\`` })));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd(t('resume.empty')));
    return shell(t('resume.title'), elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? t('common.currentMarker') : '';
    const detail = e.detail ?? t('resume.lineCountDetail', { n: e.lineCount ?? 0 });
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? t('resume.button.current') : t('resume.button.resumeThis'),
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell(t('resume.title'), elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell(t('help.title'), [
    divMd(t('help.body', { agent: escapedAgentName })),
    HR,
    actions([
      { text: t('help.button.status'), value: { cmd: 'status' }, style: 'primary' },
      { text: t('common.button.resume'), value: { cmd: 'resume' } },
      { text: t('ws.title'), value: { cmd: 'ws.list' } },
      { text: t('common.button.newSession'), value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
