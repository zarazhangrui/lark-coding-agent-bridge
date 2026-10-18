import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityFor,
  claudeCapability,
  codexCapability,
  kimiCapability,
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

  it('defines Kimi capability with session-kind sessions and stdin prompt injection', () => {
    expect(kimiCapability()).toMatchObject({
      agentId: 'kimi',
      sessionKind: 'kimi-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'full',
      },
    });
  });

  it('uses Kimi profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'kimi',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(kimiCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('dispatches capabilityFor to the matching agent kind', () => {
    const claude = createDefaultProfileConfig({ agentKind: 'claude', accounts: appAccount() });
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
      codex: { binaryPath: '/usr/local/bin/codex' },
    });
    const kimi = createDefaultProfileConfig({ agentKind: 'kimi', accounts: appAccount() });

    expect(capabilityFor(claude).agentId).toBe('claude');
    expect(capabilityFor(codex).agentId).toBe('codex');
    expect(capabilityFor(kimi).agentId).toBe('kimi');
  });
});

function appAccount() {
  return {
    app: {
      id: 'cli_test',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}
