import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, MEETING_DEFAULTS } from '../../../src/config/profile-schema';
import {
  MEETING_DENY_REPLY,
  meetingAccessConverged,
  meetingAuthzGate,
  meetingAuthzSummary,
  meetingEffectiveAccess,
} from '../../../src/meeting/authz';
import { matchElevation } from '../../../src/meeting/orchestrator';

function profile(over: { meeting?: object; access?: object; permissions?: object; mode?: 'personal' | 'team' } = {}) {
  const pc = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'x', tenant: 'feishu' } },
  });
  pc.meeting = { ...MEETING_DEFAULTS, ...over.meeting };
  Object.assign(pc.access, over.access ?? {});
  Object.assign(pc.permissions, over.permissions ?? {});
  if (over.mode) pc.mode = over.mode;
  return pc;
}

function deps(pc: ReturnType<typeof profile>, owner = 'ou_owner') {
  const said: string[] = [];
  return {
    said,
    d: {
      session: {
        meetingId: 'm1',
        deniedCount: 0,
        sendMessage: vi.fn(async (t: string) => {
          said.push(t);
        }),
      },
      controls: { profileConfig: pc, botOwnerId: owner, ownerRefreshState: 'ok' as const },
    },
  };
}

const none = () => undefined;

describe('meetingAuthzGate', () => {
  it('fails closed without a sender id', async () => {
    const { d, said } = deps(profile());
    expect(meetingAuthzGate(d, { from: {} }, 'q', none)).toEqual({ ok: false });
    await Promise.resolve();
    expect(said).toEqual([MEETING_DENY_REPLY]);
  });

  it('owner, allowedUsers, admins and team mode pass under dm-policy', () => {
    expect(meetingAuthzGate(deps(profile()).d, { from: { id: 'ou_owner' } }, 'q', none).ok).toBe(true);
    const pc = profile({ access: { allowedUsers: ['ou_a'], admins: ['ou_admin'] } });
    expect(meetingAuthzGate(deps(pc).d, { from: { id: 'ou_a' } }, 'q', none).ok).toBe(true);
    expect(meetingAuthzGate(deps(pc).d, { from: { id: 'ou_admin' } }, 'q', none).ok).toBe(true);
    expect(meetingAuthzGate(deps(profile({ mode: 'team' })).d, { from: { id: 'ou_x' } }, 'q', none).ok).toBe(true);
  });

  it('admins-only refuses allowedUsers', () => {
    const pc = profile({ meeting: { access: 'admins-only' }, access: { allowedUsers: ['ou_a'], admins: ['ou_admin'] } });
    expect(meetingAuthzGate(deps(pc).d, { from: { id: 'ou_a' } }, 'q', none).ok).toBe(false);
    expect(meetingAuthzGate(deps(pc).d, { from: { id: 'ou_admin' } }, 'q', none).ok).toBe(true);
  });

  it('tells each refused sender once but counts every refusal', async () => {
    const { d, said } = deps(profile());
    for (const id of ['ou_x', 'ou_x', 'ou_y']) meetingAuthzGate(d, { from: { id } }, 'q', none);
    await Promise.resolve();
    expect(said).toHaveLength(2);
    expect(d.session.deniedCount).toBe(3);
  });

  it('elevation needs a configured word', () => {
    const { d } = deps(profile());
    const g = meetingAuthzGate(d, { from: { id: 'ou_owner' } }, '!write x', () => 'x');
    expect(g).toMatchObject({ ok: true, elevate: false, question: '!write x' });
  });

  it('elevation is for admins only and must raise the tier', async () => {
    const pc = profile({
      meeting: { elevateWord: '!write' },
      access: { allowedUsers: ['ou_a'] },
      permissions: { defaultAccess: 'workspace', maxAccess: 'full' },
    });
    const { d, said } = deps(pc);
    expect(meetingAuthzGate(d, { from: { id: 'ou_a' } }, 'x', () => 'x').ok).toBe(false); // 白名单同事不能提权
    expect(meetingAuthzGate(d, { from: { id: 'ou_a' } }, 'x', () => undefined).ok).toBe(true);
    expect(meetingAuthzGate(d, { from: { id: 'ou_owner' } }, 'x', () => 'x')).toMatchObject({ ok: true, elevate: true });
    const flat = profile({ meeting: { elevateWord: '!write' }, permissions: { defaultAccess: 'read-only' } });
    const f = deps(flat);
    expect(meetingAuthzGate(f.d, { from: { id: 'ou_owner' } }, 'x', () => 'x').ok).toBe(false);
    await Promise.resolve();
    expect(f.said[0]).toContain('提权没有效果');
    expect(said.length).toBe(1);
  });

  it('elevation with nothing after the word answers with usage and runs nothing', async () => {
    const { d, said } = deps(profile({ meeting: { elevateWord: '!write' }, permissions: { defaultAccess: 'workspace', maxAccess: 'full' } }));
    expect(meetingAuthzGate(d, { from: { id: 'ou_owner' } }, '!write', () => '').ok).toBe(false);
    await Promise.resolve();
    expect(said[0]).toContain('用法');
  });
});

describe('matchElevation', () => {
  const p = ['@bot', '@助手'];
  it('only right after a trigger, only as a whole word', () => {
    expect(matchElevation('@bot !write 改 README', p, '!write')).toBe('改 README');
    expect(matchElevation('改 README @助手，!write', p, '!write')).toBe('改 README');
    expect(matchElevation('@bot 别用 !write 了', p, '!write')).toBeUndefined();
    expect(matchElevation('@bot !writer 你好', p, '!write')).toBeUndefined();
    expect(matchElevation('@bot !write', p, '!write')).toBe('');
    expect(matchElevation('@bot 解释 foo@bot !write 是啥', p, '!write')).toBeUndefined();
  });
});

describe('effective access', () => {
  it('elevated = the higher of meeting tier and default; never lowers', () => {
    const pc = profile({ meeting: { executionAccess: 'full' }, permissions: { defaultAccess: 'workspace', maxAccess: 'full' } });
    expect(meetingEffectiveAccess(pc, true)).toBe('full');
  });

  it('uses executionAccess, or the default when elevated, never above maxAccess', () => {
    const pc = profile({
      meeting: { executionAccess: 'workspace' },
      permissions: { defaultAccess: 'full', maxAccess: 'workspace' },
    });
    expect(meetingEffectiveAccess(pc, false)).toBe('workspace');
    expect(meetingEffectiveAccess(pc, true)).toBe('workspace');
    const low = profile({ meeting: { executionAccess: 'full' }, permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' } });
    expect(meetingEffectiveAccess(low, false)).toBe('read-only');
    expect(meetingAccessConverged(low)).toBe(true);
    expect(meetingAuthzSummary(low)).toContain('已被 profile maxAccess 收敛');
    expect(meetingAuthzSummary(profile())).toContain('提权词 已关闭');
  });
});
