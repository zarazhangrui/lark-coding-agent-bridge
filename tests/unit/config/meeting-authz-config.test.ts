import { describe, expect, it } from 'vitest';
import { MEETING_DEFAULTS, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { parseMeetingBody } from '../../../src/ui/api';

const base = { schemaVersion: 2, agentKind: 'claude', accounts: { app: { id: 'cli_x', secret: 'x', tenant: 'feishu' } } };

describe('meeting authorization defaults', () => {
  it('unconfigured = DM allowlist, read-only, no elevation', () => {
    const m = normalizeProfileConfig(base).meeting;
    expect(m.access).toBe('dm-policy');
    expect(m.executionAccess).toBe('read-only');
    expect(m.elevateWord).toBe('');
  });

  it('keeps valid values and rejects unknown ones', () => {
    const m = normalizeProfileConfig({
      ...base,
      meeting: { access: 'admins-only', executionAccess: 'workspace', elevateWord: ' !write ' },
    }).meeting;
    expect([m.access, m.executionAccess, m.elevateWord]).toEqual(['admins-only', 'workspace', '!write']);
    const bad = normalizeProfileConfig({ ...base, meeting: { access: 'everyone', executionAccess: 'root' } }).meeting;
    expect([bad.access, bad.executionAccess]).toEqual(['dm-policy', 'read-only']);
  });

  it('saving the console form keeps the authorization', () => {
    const current = {
      ...MEETING_DEFAULTS,
      access: 'admins-only' as const,
      elevateWord: '!write',
    };
    const next = parseMeetingBody({ enabled: true, access: 'dm-policy', elevateWord: '' }, current);
    expect(next.access).toBe('admins-only');
    expect(next.elevateWord).toBe('!write');
    expect(next.enabled).toBe(true);
  });
});
