import type { AgentCapability } from '../agent/capability';
import {
  accessToClaudePermissionMode,
  accessToCodexSandbox,
  clampAccess,
  type AccessMode,
  type ClaudePermissionMode,
  type CodexSandboxMode,
} from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from './access';
import {
  accessPolicyDigest,
  attachmentPolicyConfigDigest,
  policyFingerprint,
  resourceScopeDigest,
} from './fingerprint';

export interface ScopeContext {
  source: 'im' | 'card' | 'comment';
  chatId?: string;
  threadId?: string;
  actorId: string;
  commentScopeId?: string;
  resourceBindings?: ResourceBinding[];
}

export interface ResourceBinding {
  kind: 'doc' | 'folder';
  id: string;
  verified: boolean;
}

export interface AgentAttachment {
  kind: string;
  requiredness: 'required' | 'optional';
  decision: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
  originalName?: string;
  size?: number;
  hash?: string;
  path?: string;
}

export interface RunPolicyInput {
  scope: ScopeContext;
  attachments: AgentAttachment[];
  prompt: string;
  requestedCwd: string;
  cwdRealpath: string;
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  now: number;
  agentHome?: string;
  inheritAgentHome?: boolean;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ttlMs?: number;
}

export interface RunPolicyAllow {
  ok: true;
  prompt: string;
  requestedCwd: string;
  cwdRealpath: string;
  accessMode: AccessMode;
  sandbox: CodexSandboxMode;
  permissionMode: ClaudePermissionMode;
  access: AccessDecision;
  attachments: AgentAttachment[];
  policyFingerprint: string;
  expiresAt: number;
}

export interface RunPolicyReject {
  ok: false;
  rejectReason: {
    code:
      | 'access-denied'
      | 'folder-allowlist-unverified'
      | 'required-attachment-rejected';
    userVisible: string;
  };
}

export type RunPolicyResult = RunPolicyAllow | RunPolicyReject;

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function evaluateRunPolicy(input: RunPolicyInput): RunPolicyResult {
  if (!input.access.ok) {
    return reject('access-denied', '当前用户无权发起运行。');
  }

  if (input.scope.resourceBindings?.some((binding) => binding.kind === 'folder' && !binding.verified)) {
    return reject('folder-allowlist-unverified', '暂不支持 folder allowlist，已拒绝运行。');
  }

  if (
    input.attachments.some(
      (attachment) =>
        attachment.requiredness === 'required' && attachment.decision !== 'accepted',
    )
  ) {
    return reject('required-attachment-rejected', '必需附件未通过校验，已拒绝运行。');
  }

  const accessMode = clampAccess(
    input.profileConfig.permissions.defaultAccess,
    input.profileConfig.permissions.maxAccess,
    input.capability.permissions.maxAccess,
  );
  const sandbox = accessToCodexSandbox(accessMode);
  const permissionMode = accessToClaudePermissionMode(
    accessMode,
    input.profileConfig.permissions,
  );
  const resourceDigest = resourceScopeDigest({
    source: input.scope.source,
    chatId: input.scope.chatId,
    threadId: input.scope.threadId,
    commentScopeId: input.scope.commentScopeId,
    resourceBindings: input.scope.resourceBindings?.map((binding) => binding.id),
  });
  const attachmentDigest = attachmentPolicyConfigDigest(input.profileConfig.attachments);
  const accessDigest =
    input.scope.source === 'comment' && input.access.reason === 'comment-mention'
      ? 'comment-mention'
      : accessPolicyDigest(input.profileConfig.access);

  return {
    ok: true,
    prompt: input.prompt,
    requestedCwd: input.requestedCwd,
    cwdRealpath: input.cwdRealpath,
    accessMode,
    sandbox,
    permissionMode,
    access: input.access,
    attachments: input.attachments,
    expiresAt: input.now + (input.ttlMs ?? DEFAULT_TTL_MS),
    policyFingerprint: policyFingerprint({
      cwdRealpath: input.cwdRealpath,
      sandbox,
      accessPolicyDigest: accessDigest,
      resourceScopeDigest: resourceDigest,
      attachmentPolicyShapeDigest: attachmentDigest,
      codexHome: input.agentHome ?? input.codexHome,
      inheritCodexHome: input.inheritAgentHome ?? input.inheritCodexHome ?? false,
    }),
  };
}

function reject(code: RunPolicyReject['rejectReason']['code'], userVisible: string): RunPolicyReject {
  return {
    ok: false,
    rejectReason: {
      code,
      userVisible,
    },
  };
}
