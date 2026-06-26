import { describe, expect, it } from 'vitest';
import {
  accessPolicyDigest,
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  isCreator,
  type RuntimeControls,
} from '../../../src/policy/access';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';

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
    // Use a populated allowlist (a user other than the owner) so open-mode is
    // OFF and the only path to access is being recognized as the owner.
    const profile = profileWithAccess({ allowedUsers: ['ou_someone_else'] });
    const controls: RuntimeControls = {
      ownerRefreshState: 'failed',
      ownerRefreshError: 'permission denied',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('does not grant creator access before owner refresh has resolved', () => {
    const profile = profileWithAccess({ allowedUsers: ['ou_someone_else'] });
    const controls: RuntimeControls = {
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'unknown',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('opens DMs to everyone when the allowlists are empty (open mode)', () => {
    const open = profileWithAccess();
    expect(canUseDm(open, ownerControls, 'ou_other')).toEqual({ ok: true, reason: 'open' });

    // Once any allowlist is populated, open mode turns off and gating returns.
    const byUser = profileWithAccess({ allowedUsers: ['ou_other'] });
    expect(canUseDm(byUser, ownerControls, 'ou_other').ok).toBe(true);
    expect(canUseDm(byUser, ownerControls, 'ou_nobody').ok).toBe(false);

    const byAdmin = profileWithAccess({ admins: ['ou_other'] });
    expect(canUseDm(byAdmin, ownerControls, 'ou_other').ok).toBe(true);
    expect(canUseDm(byAdmin, ownerControls, 'ou_nobody').ok).toBe(false);
  });

  it('opens groups to everyone when the allowlists are empty (open mode)', () => {
    const open = profileWithAccess();
    expect(canUseGroup(open, ownerControls, 'chat_any', 'ou_other')).toEqual({
      ok: true,
      reason: 'open',
    });

    // A populated chat allowlist restores per-chat gating.
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

function profileWithAccess(access: Partial<ProfileConfig['access']> = {}): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
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
