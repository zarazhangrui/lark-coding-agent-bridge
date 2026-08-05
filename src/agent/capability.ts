import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'kimi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'kimi-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'argv-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function kimiCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'kimi',
    sessionKind: 'kimi-session',
    promptInjection: 'argv-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Resolve the capability for any profile kind. Centralises the claude/codex/
 * kimi dispatch so callers don't repeat three-way ternaries (easy to get
 * wrong when a new agent kind is added).
 */
export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  switch (profile.agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'kimi':
      return kimiCapability(profile);
    default:
      return claudeCapability(profile);
  }
}
