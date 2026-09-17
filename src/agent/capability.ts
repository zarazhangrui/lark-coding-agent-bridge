import type { AccessMode } from '../config/permissions';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'qodercli';
export type AgentSessionKind = 'claude-session' | 'codex-thread';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

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
 * Qoder CLI capability. Session semantics match Claude Code (per-run
 * `session_id`, resumable via `--resume <id>`); the bridge system prompt is
 * delivered as a stdin prefix because qodercli has no system-prompt file
 * flag and argv is unsafe for XML blocks on Windows (see QoderAdapter).
 */
export function qodercliCapability(
  profile?: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'qodercli',
    sessionKind: 'claude-session',
    promptInjection: 'stdin-prefix',
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

/** Capability for a profile's agent kind. */
export function capabilityForAgentKind(
  agentKind: AgentKind,
  profile: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  if (agentKind === 'codex') return codexCapability(profile);
  if (agentKind === 'qodercli') return qodercliCapability(profile);
  return claudeCapability(profile);
}

/** True for agents that resume by claude-style session ids. */
export function isSessionIdAgent(agentId: AgentCapabilityId): boolean {
  return agentId === 'claude' || agentId === 'qodercli';
}
