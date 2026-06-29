import type { ProfileConfig } from '../config/profile-schema';
export { accessPolicyDigest } from './fingerprint';

export type OwnerRefreshState = 'ok' | 'failed' | 'unknown';

export interface RuntimeControls {
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
}

export interface AccessDecision {
  ok: boolean;
  reason:
    | 'owner'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-chat'
    | 'comment-mention'
    | 'denied-user'
    | 'denied-chat'
    | 'denied-admin';
}

export function isCreator(controls: RuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}

export function canUseDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-user');
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.access.allowedChats.includes(chatId)) return allow('allowed-chat');
  return deny('denied-chat');
}

/**
 * Human-admins-only gate.  Owner or entries in `admins[]` pass; botAdmins
 * do NOT satisfy this check.  Use for credential/role-elevation commands.
 */
export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

/**
 * Operational-admin gate.  Owner, human admins, AND botAdmins all pass.
 * Use for project-operations commands (group join/leave, cwd, project
 * start, status queries).  botAdmin entries are keyed by the bot's
 * identity as it appears in senderId (open_id at runtime; stored as
 * app_id on disk where possible).
 */
export function canRunBotAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.access.botAdmins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

/** True when senderId is in the botAdmins list (without owner/admin fallback). */
export function isBotAdmin(profile: ProfileConfig, senderId: string): boolean {
  return profile.access.botAdmins.includes(senderId);
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
