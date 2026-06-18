import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { getReceiveMode } from '../../../src/config/schema.js';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'cli_test', secret: 'x', tenant: 'feishu' } },
    preferences,
  } as AppConfig;
}

describe('getReceiveMode', () => {
  it('derives the default mode from the global requireMentionInGroup', () => {
    expect(getReceiveMode(cfg({ requireMentionInGroup: true }), 'oc_a')).toBe('mention');
    expect(getReceiveMode(cfg({ requireMentionInGroup: false }), 'oc_a')).toBe('all');
    // undefined global → safe default of 'mention'
    expect(getReceiveMode(cfg({}), 'oc_a')).toBe('mention');
  });

  it('lets a per-chat override win over the global default', () => {
    expect(
      getReceiveMode(
        cfg({ requireMentionInGroup: true, perChatReceiveMode: { oc_a: 'all' } }),
        'oc_a',
      ),
    ).toBe('all');
    expect(
      getReceiveMode(
        cfg({ requireMentionInGroup: true, perChatReceiveMode: { oc_a: 'smart' } }),
        'oc_a',
      ),
    ).toBe('smart');
    // override back to mention even when global is reply-all
    expect(
      getReceiveMode(
        cfg({ requireMentionInGroup: false, perChatReceiveMode: { oc_b: 'mention' } }),
        'oc_b',
      ),
    ).toBe('mention');
  });

  it('only affects the chat named in the override map', () => {
    const c = cfg({ requireMentionInGroup: true, perChatReceiveMode: { oc_a: 'smart' } });
    expect(getReceiveMode(c, 'oc_a')).toBe('smart');
    expect(getReceiveMode(c, 'oc_other')).toBe('mention');
  });

  it('ignores an invalid override value and falls back to the global default', () => {
    const c = cfg({
      requireMentionInGroup: false,
      perChatReceiveMode: { oc_a: 'bogus' as never },
    });
    expect(getReceiveMode(c, 'oc_a')).toBe('all');
  });
});
