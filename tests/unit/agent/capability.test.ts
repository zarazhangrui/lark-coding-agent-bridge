import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import { capabilityForAgentKind, claudeCapability, codexCapability } from '../../../src/agent/capability';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';

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
});

describe('capabilityForAgentKind', () => {
  const basePermissions: ProfileConfig['permissions'] = {
    defaultAccess: 'full',
    maxAccess: 'full',
  };

  it('returns the pi capability with native history and stdin-prefix injection', () => {
    const capability = capabilityForAgentKind('pi', { permissions: basePermissions });
    expect(capability.agentId).toBe('pi');
    expect(capability.sessionKind).toBe('pi-session');
    expect(capability.promptInjection).toBe('stdin-prefix');
    expect(capability.supportsNativeHistory).toBe(true);
  });

  it('still returns codex and claude capabilities unchanged', () => {
    expect(capabilityForAgentKind('codex', { permissions: basePermissions }).agentId).toBe('codex');
    expect(capabilityForAgentKind('claude', { permissions: basePermissions }).agentId).toBe('claude');
  });
});
