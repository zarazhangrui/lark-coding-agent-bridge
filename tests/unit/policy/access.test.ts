import { describe, expect, it } from 'vitest';
import {
  accessPolicyDigest,
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  isCreator,
  requireMentionForChat,
  type RuntimeControls,
} from '../../../src/policy/access';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import type { AppConfig } from '../../../src/config/schema';

const ownerControls: RuntimeControls = {
  botOwnerId: 'ou_owner',
  ownerRefreshState: 'ok',
};

describe('access policy', () => {
  it('lets the runtime owner use DMs, groups, and admin commands regardless of lists', () => {
    const profile = profileWithAccess();

    expect(isCreator(ownerControls, 'ou_owner')).toBe(true);
    expect(canUseDm(profile, ownerControls, 'ou_owner').ok).toBe(true);
    expect(canUseGroup(profile, ownerControls, 'chat_any', 'ou_owner').ok).toBe(true);
    expect(canRunAdminCommand(profile, ownerControls, 'ou_owner').ok).toBe(true);
  });

  it('uses a cached owner even when the last owner refresh failed', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'failed',
      ownerRefreshError: 'permission denied',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(true);
    expect(canUseDm(profile, controls, 'ou_owner')).toEqual({ ok: true, reason: 'owner' });
    expect(canRunAdminCommand(profile, controls, 'ou_owner')).toEqual({ ok: true, reason: 'owner' });
  });

  it('does not grant creator access without a cached owner', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      ownerRefreshState: 'failed',
      ownerRefreshError: 'permission denied',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('does not grant creator access before owner refresh has resolved', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'unknown',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('fails closed for non-owner DMs unless allowedUsers or admins include sender', () => {
    const closed = profileWithAccess();
    expect(canUseDm(closed, ownerControls, 'ou_other').ok).toBe(false);

    const byUser = profileWithAccess({ allowedUsers: ['ou_other'] });
    expect(canUseDm(byUser, ownerControls, 'ou_other').ok).toBe(true);

    const byAdmin = profileWithAccess({ admins: ['ou_other'] });
    expect(canUseDm(byAdmin, ownerControls, 'ou_other').ok).toBe(true);
  });

  it('fails closed for groups unless owner, admin, or allowedChats includes the chat', () => {
    const closed = profileWithAccess();
    expect(canUseGroup(closed, ownerControls, 'chat_allowed', 'ou_other').ok).toBe(false);

    const allowed = profileWithAccess({ allowedChats: ['chat_allowed'] });
    expect(canUseGroup(allowed, ownerControls, 'chat_allowed', 'ou_other').ok).toBe(true);
    expect(canUseGroup(allowed, ownerControls, 'chat_other', 'ou_other').ok).toBe(false);
  });

  it('lets admins use groups before the chat is allowlisted', () => {
    const profile = profileWithAccess({ admins: ['ou_admin'] });

    expect(canUseGroup(profile, ownerControls, 'chat_new', 'ou_admin')).toEqual({
      ok: true,
      reason: 'allowed-admin',
    });
  });

  it('treats empty admins as zero admins while preserving owner admin access', () => {
    const profile = profileWithAccess();

    expect(canRunAdminCommand(profile, ownerControls, 'ou_other').ok).toBe(false);
    expect(canRunAdminCommand(profile, ownerControls, 'ou_owner').ok).toBe(true);

    const withAdmin = profileWithAccess({ admins: ['ou_admin'] });
    expect(canRunAdminCommand(withAdmin, ownerControls, 'ou_admin').ok).toBe(true);
  });

  it('opens usage to everyone in team mode without touching admin gating', () => {
    const team = profileWithAccess({}, 'team');

    // Anyone can use DMs and groups — no allowlist needed.
    expect(canUseDm(team, ownerControls, 'ou_stranger')).toEqual({
      ok: true,
      reason: 'allowed-team',
    });
    expect(canUseGroup(team, ownerControls, 'chat_random', 'ou_stranger')).toEqual({
      ok: true,
      reason: 'allowed-team',
    });

    // Admin/sensitive commands are still owner/admin-gated.
    expect(canRunAdminCommand(team, ownerControls, 'ou_stranger').ok).toBe(false);
    expect(canRunAdminCommand(team, ownerControls, 'ou_owner').ok).toBe(true);

    const teamWithAdmin = profileWithAccess({ admins: ['ou_admin'] }, 'team');
    expect(canRunAdminCommand(teamWithAdmin, ownerControls, 'ou_admin').ok).toBe(true);
  });

  it('does not include runtime owner state in the access policy digest', () => {
    const profile = profileWithAccess({
      allowedUsers: ['ou_a'],
      allowedChats: ['chat_a'],
      admins: ['ou_admin'],
    });

    expect(accessPolicyDigest(profile.access)).toBe(accessPolicyDigest(profile.access));
    expect(accessPolicyDigest(profile.access)).toBe(
      accessPolicyDigest({
        ...profile.access,
        allowedUsers: ['ou_a'],
      }),
    );
  });
});

describe('requireMentionForChat', () => {
  const globalOn = { preferences: { requireMentionInGroup: true } } as AppConfig;
  const globalOff = { preferences: { requireMentionInGroup: false } } as AppConfig;

  it('follows the global setting when a chat has no override', () => {
    const profile = profileWithAccess();
    expect(requireMentionForChat(profile, globalOn, 'oc_x')).toBe(true);
    expect(requireMentionForChat(profile, globalOff, 'oc_x')).toBe(false);
  });

  it('lets a per-chat override win over the global setting, both directions', () => {
    const profile = profileWithAccess({ chatRequireMention: { oc_open: false, oc_strict: true } });
    // Global requires @, but oc_open overrides to respond-to-all.
    expect(requireMentionForChat(profile, globalOn, 'oc_open')).toBe(false);
    // Global responds to all, but oc_strict overrides to require @.
    expect(requireMentionForChat(profile, globalOff, 'oc_strict')).toBe(true);
    // An unlisted chat still follows the global setting.
    expect(requireMentionForChat(profile, globalOn, 'oc_other')).toBe(true);
  });
});

function profileWithAccess(
  access: Partial<ProfileConfig['access']> = {},
  mode: ProfileConfig['mode'] = 'personal',
): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    mode,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    access,
  });
}
