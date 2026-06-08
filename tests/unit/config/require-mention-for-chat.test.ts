import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { getRequireMentionForChat } from '../../../src/config/schema.js';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'cli_test', secret: 'x', tenant: 'feishu' } },
    preferences,
  } as AppConfig;
}

describe('getRequireMentionForChat', () => {
  it('falls back to the global default when the chat has no override', () => {
    expect(getRequireMentionForChat(cfg({ requireMentionInGroup: true }), 'oc_a')).toBe(true);
    expect(getRequireMentionForChat(cfg({ requireMentionInGroup: false }), 'oc_a')).toBe(false);
    // undefined global → safe default of true
    expect(getRequireMentionForChat(cfg({}), 'oc_a')).toBe(true);
  });

  it('lets a per-chat override win over the global default in both directions', () => {
    // global requires @, but oc_a opts into reply-all
    expect(
      getRequireMentionForChat(
        cfg({ requireMentionInGroup: true, perChatRequireMention: { oc_a: false } }),
        'oc_a',
      ),
    ).toBe(false);
    // global is reply-all, but oc_b opts back into @-only
    expect(
      getRequireMentionForChat(
        cfg({ requireMentionInGroup: false, perChatRequireMention: { oc_b: true } }),
        'oc_b',
      ),
    ).toBe(true);
  });

  it('only affects the chat named in the override map', () => {
    const c = cfg({ requireMentionInGroup: true, perChatRequireMention: { oc_a: false } });
    expect(getRequireMentionForChat(c, 'oc_a')).toBe(false);
    expect(getRequireMentionForChat(c, 'oc_other')).toBe(true);
  });
});
