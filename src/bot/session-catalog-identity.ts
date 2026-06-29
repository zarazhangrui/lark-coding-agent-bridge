import type { NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability, traeCapability } from '../agent/capability';
import type { Controls } from '../commands';
import type { AccessDecision } from '../policy/access';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalogIdentity } from '../session/catalog';
import type { WorkspaceStore } from '../workspace/store';
import type { ChatMode } from './chat-mode-cache';

export async function commandSessionCatalogIdentity(input: {
  msg: NormalizedMessage;
  scope: string;
  mode: ChatMode;
  workspaces: WorkspaceStore;
  controls: Controls;
  access: AccessDecision;
}): Promise<SessionCatalogIdentity | undefined> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scope) ?? input.controls.profileConfig.workspaces.default;
  if (!requestedCwd) return undefined;
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) return undefined;
  const capability =
    input.controls.profileConfig.agentKind === 'codex'
      ? codexCapability(input.controls.profileConfig)
      : input.controls.profileConfig.agentKind === 'trae'
        ? traeCapability(input.controls.profileConfig)
        : claudeCapability(input.controls.profileConfig);
  const activeAgentHome =
    input.controls.profileConfig.agentKind === 'codex'
      ? {
          ...(input.controls.profileConfig.codex?.codexHome
            ? { agentHome: input.controls.profileConfig.codex.codexHome }
            : {}),
          ...(input.controls.profileConfig.codex?.inheritCodexHome !== undefined
            ? { inheritAgentHome: input.controls.profileConfig.codex.inheritCodexHome }
            : {}),
        }
      : input.controls.profileConfig.agentKind === 'trae'
        ? {
            ...(input.controls.profileConfig.trae?.traeHome
              ? { agentHome: input.controls.profileConfig.trae.traeHome }
              : {}),
            ...(input.controls.profileConfig.trae?.inheritTraeHome !== undefined
              ? { inheritAgentHome: input.controls.profileConfig.trae.inheritTraeHome }
              : {}),
          }
        : {};
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: input.msg.chatId,
      actorId: input.msg.senderId,
      ...(input.mode === 'topic' && input.msg.threadId ? { threadId: input.msg.threadId } : {}),
    },
    attachments: [],
    prompt: '',
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability,
    profileConfig: input.controls.profileConfig,
    now: Date.now(),
    ...activeAgentHome,
  });
  if (!policy.ok) return undefined;
  return {
    scopeId: input.scope,
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}
