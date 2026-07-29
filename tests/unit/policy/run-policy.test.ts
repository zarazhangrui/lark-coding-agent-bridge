import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability';
import type { AccessMode } from '../../../src/config/permissions';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import {
  evaluateRunPolicy,
  type RunPolicyInput,
  type ScopeContext,
} from '../../../src/policy/run-policy';

describe('run policy', () => {
  it('rejects when the upstream access decision denies the actor', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      access: { ok: false, reason: 'denied-user' },
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'access-denied',
      },
    });
  });

  it('allows any resolved working directory because cwd is not an authorization boundary', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      requestedCwd: '/outside/project',
      cwdRealpath: '/outside/project',
      profileConfig: profile(),
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ['full', 'danger-full-access', 'bypassPermissions'],
    ['workspace', 'workspace-write', 'acceptEdits'],
    ['read-only', 'read-only', 'plan'],
  ] as const)(
    'maps %s access to Codex sandbox and Claude permission mode',
    (accessMode, sandbox, permissionMode) => {
      const result = evaluateRunPolicy(
        baseInput({
          profileConfig: profile({
            permissions: {
              defaultAccess: accessMode,
              maxAccess: accessMode,
            },
          }),
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected run policy to allow');
      expect(result.accessMode).toBe(accessMode);
      expect(result.sandbox).toBe(sandbox);
      expect(result.permissionMode).toBe(permissionMode);
    },
  );

  it('does not raise access above capability maxAccess', () => {
    const result = evaluateRunPolicy({
      ...baseInput({
        profileConfig: profile({
          agentKind: 'codex',
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        }),
      }),
      capability: codexCapability(
        profile({
          agentKind: 'codex',
          permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
        }),
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run policy to allow');
    expect(result.accessMode).toBe('read-only');
    expect(result.sandbox).toBe('read-only');
    expect(result.permissionMode).toBe('plan');
  });

  it('uses maxAccess for allowlisted agent users and defaultAccess for other actors', () => {
    const profileConfig = profile({
      permissions: { defaultAccess: 'read-only', maxAccess: 'full' },
      agentUsers: ['ou_agent'],
    });
    const agentResult = evaluateRunPolicy(
      baseInput({
        profileConfig,
        scope: scope({ actorId: 'ou_agent' }),
      }),
    );
    const readerResult = evaluateRunPolicy(
      baseInput({
        profileConfig,
        scope: scope({ actorId: 'ou_reader' }),
      }),
    );

    expect(agentResult).toMatchObject({
      ok: true,
      accessMode: 'full',
      sandbox: 'danger-full-access',
      permissionMode: 'bypassPermissions',
    });
    expect(readerResult).toMatchObject({
      ok: true,
      accessMode: 'read-only',
      sandbox: 'read-only',
      permissionMode: 'plan',
    });
  });

  it('returns an expiry and a stable policy fingerprint for accepted runs', () => {
    const input = baseInput({ now: 1000 });
    const result = evaluateRunPolicy(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run policy to allow');
    expect(result.expiresAt).toBeGreaterThan(1000);
    expect(result.policyFingerprint).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(evaluateRunPolicy(input)).toMatchObject({
      ok: true,
      policyFingerprint: result.policyFingerprint,
    });
  });

  it('fingerprints the attachment policy shape instead of concrete run attachments', () => {
    const noAttachment = evaluateRunPolicy(baseInput());
    const withAcceptedImage = evaluateRunPolicy({
      ...baseInput(),
      attachments: [
        {
          kind: 'image',
          requiredness: 'optional',
          decision: 'accepted',
          originalName: 'sensitive-name.png',
          size: 123,
          hash: 'hash-a',
          path: '/profile/media/hash-a.png',
        },
      ],
    });
    const stricterPolicy = evaluateRunPolicy({
      ...baseInput({
        profileConfig: profile({
          attachments: { maxFileBytes: 1 },
        }),
      }),
    });

    expect(noAttachment.ok).toBe(true);
    expect(withAcceptedImage.ok).toBe(true);
    expect(stricterPolicy.ok).toBe(true);
    if (!noAttachment.ok || !withAcceptedImage.ok || !stricterPolicy.ok) {
      throw new Error('expected run policy to allow');
    }
    expect(withAcceptedImage.policyFingerprint).toBe(noAttachment.policyFingerprint);
    expect(stricterPolicy.policyFingerprint).not.toBe(noAttachment.policyFingerprint);
  });

  it('fails closed for unverified folder resource bindings', () => {
    const result = evaluateRunPolicy({
      ...baseInput(),
      scope: scope({
        resourceBindings: [{ kind: 'folder', id: 'fld_secret', verified: false }],
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'folder-allowlist-unverified',
      },
    });
  });

  it('is pure policy calculation and does not import IO or API clients', () => {
    const source = readFileSync(join(process.cwd(), 'src/policy/run-policy.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]node:fs|from ['"]node:fs\/promises|fs\.realpath|fs\.stat|statSync|realpathSync/);
    expect(source).not.toMatch(/rawClient|LarkChannel|createLarkChannel/);
    expect(source).not.toMatch(/writeFile|mkdir|rm\(/);
  });
});

function baseInput(overrides: Partial<RunPolicyInput> = {}): RunPolicyInput {
  const profileConfig = overrides.profileConfig ?? profile();
  return {
    scope: scope(),
    attachments: [],
    prompt: 'hello',
    requestedCwd: '/repo/project',
    cwdRealpath: '/repo/project',
    access: { ok: true, reason: 'allowed-user' },
    capability: claudeCapability(profileConfig),
    profileConfig,
    now: 1000,
    ...overrides,
  };
}

function profile(options: {
  agentKind?: 'claude' | 'codex';
  permissions?: {
    defaultAccess: AccessMode;
    maxAccess: AccessMode;
  };
  attachments?: Partial<ProfileConfig['attachments']>;
  agentUsers?: string[];
} = {}) {
  const cfg = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(options.agentKind === 'codex'
      ? { codex: { binaryPath: '/usr/local/bin/codex' } }
      : {}),
    permissions: options.permissions,
    access: {
      agentUsers: options.agentUsers,
    },
  });
  return {
    ...cfg,
    attachments: {
      ...cfg.attachments,
      ...options.attachments,
    },
    workspaces: cfg.workspaces,
  };
}

function scope(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    source: 'im',
    chatId: 'oc_chat',
    actorId: 'ou_user',
    ...overrides,
  };
}
