import { describe, expect, it } from 'vitest';
import { getAgentKind, type AppConfig } from '../../src/config/schema';

const baseConfig: AppConfig = {
  accounts: { app: { id: 'cli_xxx', secret: 'secret', tenant: 'feishu' } },
};

describe('getAgentKind', () => {
  it('defaults to claude for missing or unknown agent values', () => {
    expect(getAgentKind(baseConfig)).toBe('claude');
    expect(
      getAgentKind({
        ...baseConfig,
        preferences: { agent: 'unknown' as never },
      }),
    ).toBe('claude');
  });

  it('returns configured supported agent values', () => {
    expect(getAgentKind({ ...baseConfig, preferences: { agent: 'codex' } })).toBe('codex');
  });
});
