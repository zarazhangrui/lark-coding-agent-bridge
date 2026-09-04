import { describe, expect, it } from 'vitest';
import { groupMentionSkipReason } from '../../../src/policy/mention';

describe('groupMentionSkipReason', () => {
  const cases = [
    { name: 'open: no mention passes', smart: false, require: false, mentionedBot: false, mentions: 0, expected: null },
    { name: 'open: @others passes', smart: false, require: false, mentionedBot: false, mentions: 1, expected: null },
    { name: 'open: @self passes', smart: false, require: false, mentionedBot: true, mentions: 1, expected: null },
    { name: 'require: no mention skipped', smart: false, require: true, mentionedBot: false, mentions: 0, expected: 'no-mention' },
    { name: 'require: @others skipped as other-mentioned', smart: false, require: true, mentionedBot: false, mentions: 1, expected: 'other-mentioned' },
    { name: 'require: @self passes', smart: false, require: true, mentionedBot: true, mentions: 1, expected: null },
    { name: 'smart: no mention passes even without require', smart: true, require: false, mentionedBot: false, mentions: 0, expected: null },
    { name: 'smart: @others skipped even without require', smart: true, require: false, mentionedBot: false, mentions: 1, expected: 'other-mentioned' },
    { name: 'smart: @self passes even without require', smart: true, require: false, mentionedBot: true, mentions: 1, expected: null },
    { name: 'smart: no mention passes even with require', smart: true, require: true, mentionedBot: false, mentions: 0, expected: null },
    { name: 'smart: @others skipped with require', smart: true, require: true, mentionedBot: false, mentions: 1, expected: 'other-mentioned' },
    { name: 'smart: @self passes with require', smart: true, require: true, mentionedBot: true, mentions: 0, expected: null },
  ] as const;

  for (const c of cases) {
    it(c.name, () => {
      expect(
        groupMentionSkipReason({
          smartMention: c.smart,
          requireMention: c.require,
          mentionedBot: c.mentionedBot,
          mentionCount: c.mentions,
        }),
      ).toBe(c.expected);
    });
  }
});
