import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityFor,
  claudeCapability,
  codexCapability,
  grokCapability,
  usesNativeSessionId,
} from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('defines Grok capability with native sessions and appended system prompt', () => {
    const capability = grokCapability();

    expect(capability).toMatchObject({
      agentId: 'grok',
      sessionKind: 'grok-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
    });
    expect(usesNativeSessionId('grok')).toBe(true);
    expect(usesNativeSessionId('claude')).toBe(true);
    expect(usesNativeSessionId('codex')).toBe(false);
  });

  it('routes capabilityFor to the matching agent kind', () => {
    const grok = createDefaultProfileConfig({
      agentKind: 'grok',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      grok: { binaryPath: '/usr/local/bin/grok' },
    });
    expect(capabilityFor(grok).agentId).toBe('grok');
    expect(capabilityFor({ agentKind: 'claude', permissions: grok.permissions }).agentId).toBe(
      'claude',
    );
  });
});
