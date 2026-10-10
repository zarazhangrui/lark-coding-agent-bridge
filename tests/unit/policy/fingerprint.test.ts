import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  accessPolicyDigest,
  attachmentPolicyShapeDigest,
  policyFingerprint,
  resourceScopeDigest,
  type FingerprintInputV2,
} from '../../../src/policy/fingerprint';
import { canonicalizeJcs } from '../../../src/session/jcs';

describe('policy fingerprint', () => {
  it('canonicalizes JSON with sorted object keys while preserving array order', () => {
    expect(
      canonicalizeJcs({
        z: 1,
        a: {
          d: [3, { z: false, a: true }],
          c: null,
        },
        b: 'text',
      }),
    ).toBe('{"a":{"c":null,"d":[3,{"a":true,"z":false}]},"b":"text","z":1}');
  });

  it('produces sha256 first-16-byte base64url fingerprints', () => {
    const fp = policyFingerprint(baseInput());

    expect(fp).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fp).not.toContain('=');
    expect(fp).toBe(policyFingerprint(baseInput()));
  });

  it('changes when policy-defining fields change', () => {
    const base = baseInput();

    for (const changed of [
      { cwdRealpath: '/repo/other' },
      { sandbox: 'workspace-write' as const },
      { accessPolicyDigest: digestOf('access-other') },
      { resourceScopeDigest: digestOf('scope-other') },
      { attachmentPolicyShapeDigest: digestOf('attachments-other') },
      { codexHome: '/state/other-codex-home' },
      { inheritCodexHome: true },
    ]) {
      expect(policyFingerprint({ ...base, ...changed })).not.toBe(policyFingerprint(base));
    }
  });

  it('ignores runtime owner, timestamp, model, and concrete attachment names or sizes', () => {
    const base = baseInput();

    expect(
      policyFingerprint({
        ...base,
        owner: 'ou_owner_a',
        timestamp: 1,
        model: 'model-a',
      } as FingerprintInputV2 & Record<string, unknown>),
    ).toBe(
      policyFingerprint({
        ...base,
        owner: 'ou_owner_b',
        timestamp: 2,
        model: 'model-b',
      } as FingerprintInputV2 & Record<string, unknown>),
    );

    expect(
      attachmentPolicyShapeDigest([
        {
          kind: 'image',
          requiredness: 'required',
          decision: 'accepted',
          originalName: 'secret-a.png',
          size: 1,
        },
      ]),
    ).toBe(
      attachmentPolicyShapeDigest([
        {
          kind: 'image',
          requiredness: 'required',
          decision: 'accepted',
          originalName: 'secret-b.png',
          size: 999,
        },
      ]),
    );
  });

  it('sorts access and resource allowlists so ordering does not change digests', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      access: {
        allowedUsers: ['ou_b', 'ou_a'],
        allowedChats: ['oc_b', 'oc_a'],
        admins: ['ou_admin_b', 'ou_admin_a'],
        agentUsers: ['ou_agent_b', 'ou_agent_a'],
      },
    });

    expect(accessPolicyDigest(profile.access)).toBe(
      accessPolicyDigest({
        ...profile.access,
        allowedUsers: ['ou_a', 'ou_b'],
        allowedChats: ['oc_a', 'oc_b'],
        admins: ['ou_admin_a', 'ou_admin_b'],
        agentUsers: ['ou_agent_a', 'ou_agent_b'],
      }),
    );
    expect(
      resourceScopeDigest({
        source: 'comment',
        chatId: 'oc_1',
        threadId: 'omt_1',
        resourceBindings: ['doc_b', 'doc_a'],
      }),
    ).toBe(
      resourceScopeDigest({
        source: 'comment',
        chatId: 'oc_1',
        threadId: 'omt_1',
        resourceBindings: ['doc_a', 'doc_b'],
      }),
    );
  });
});

function baseInput(): FingerprintInputV2 {
  return {
    cwdRealpath: '/repo/project',
    sandbox: 'read-only',
    accessPolicyDigest: digestOf('access'),
    resourceScopeDigest: digestOf('scope'),
    attachmentPolicyShapeDigest: digestOf('attachments'),
    codexHome: '/state/codex-home',
    inheritCodexHome: false,
  };
}

function digestOf(value: string): string {
  return resourceScopeDigest({ source: 'im', chatId: value });
}
