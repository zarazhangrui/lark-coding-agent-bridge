import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

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

  it('offers a custom model input for OMP and keeps the stored selector selectable', () => {
    const model = 'workbuddy/cn:space-bunny';
    const card = configFormCard({ ...base, agentKind: 'omp', model });
    const json = JSON.stringify(card);

    expect(json).toContain('"name":"model_custom"');
    expect(json).toContain(`"initial_option":"${model}"`);
    expect(json).toContain(`"value":"${model}"`);
  });

  it('does not add an OMP-only field to Claude profiles', () => {
    expect(JSON.stringify(configFormCard(base))).not.toContain('model_custom');
  });
});
