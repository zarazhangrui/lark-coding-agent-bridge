import type { AccessMode } from '../config/permissions';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'kimi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'kimi-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'agent-file';

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

/**
 * kimi-code capability. Session semantics follow claude (a `sessionId`
 * resumed via `kimi --session <id>`); the bridge system prompt is injected
 * through a per-run `--agent-file` instead of a prompt flag.
 */
export function kimiCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'kimi',
    sessionKind: 'kimi-session',
    promptInjection: 'agent-file',
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

/** Pick the capability implementation for a profile's agent kind. */
export function capabilityForAgentKind(
  agentKind: AgentKind,
  profile: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  if (agentKind === 'codex') return codexCapability(profile);
  if (agentKind === 'kimi') return kimiCapability(profile);
  return claudeCapability(profile);
}
