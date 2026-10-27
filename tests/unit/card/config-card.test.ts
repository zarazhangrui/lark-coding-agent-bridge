import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

describe('Claude effort picker', () => {
  it('places the saved effort beside the model with valid default and max options', () => {
    const card = configFormCard({ ...base, effortLevel: 'max' });
    const nodes = descendants(card);
    const picker = nodes.find((node) => node.name === 'effort_level');
    expect(picker?.initial_option).toBe('max');
    expect(picker?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'default' }),
      expect.objectContaining({ value: 'max' }),
    ]));
    const columns = nodes.find((node) =>
      node.tag === 'column_set' && JSON.stringify(node).includes('effort_level'),
    );
    expect(JSON.stringify(columns)).toContain('"name":"model"');
    expect(JSON.stringify(configSavedCard({ ...base, effortLevel: 'max' }))).toContain('Max（最高）');
  });

  it('does not add Claude controls to a Codex form', () => {
    expect(JSON.stringify(configFormCard({ ...base, agentKind: 'codex' }))).not.toContain('effort_level');
    expect(JSON.stringify(configSavedCard({ ...base, agentKind: 'codex' }))).not.toContain('思考强度');
  });

  it('shows the unspecified option for old or invalid stored preferences', () => {
    for (const effortLevel of [undefined, 'unsupported']) {
      const picker = descendants(configFormCard({ ...base, effortLevel }))
        .find((node) => node.name === 'effort_level');
      expect(picker?.initial_option).toBe('default');
    }
  });
});

function descendants(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(descendants)];
}
