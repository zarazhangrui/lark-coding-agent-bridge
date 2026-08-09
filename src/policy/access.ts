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
    | 'allowed-team'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-chat'
    | 'open'
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
  // Team mode opens up *usage* to everyone — no allowlist gating. Admin
  // commands stay owner/admin-gated via canRunAdminCommand (unchanged).
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  // Open DM: an empty user allowlist means "everyone" (no opt-in required).
  if (profile.access.allowedUsers.length === 0 && profile.access.admins.length === 0) {
    return allow('open');
  }
  return deny('denied-user');
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.access.allowedChats.includes(chatId)) return allow('allowed-chat');
  // Open group: an empty chat allowlist means "any group the bot is in".
  if (profile.access.allowedChats.length === 0 && profile.access.admins.length === 0) {
    return allow('open');
  }
  return deny('denied-chat');
}

export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
