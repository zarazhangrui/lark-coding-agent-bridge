import { describe, expect, it } from 'vitest';
import { shouldAlertRound } from '../../../src/bot/channel.js';

describe('session-round soft alert cadence (TOKEN-001 measure 7)', () => {
  it('never fires at or below the threshold', () => {
    for (let n = 0; n <= 40; n++) {
      expect(shouldAlertRound(n, 40, 10)).toBe(false);
    }
  });

  it('first fire lands on threshold + 1', () => {
    expect(shouldAlertRound(41, 40, 10)).toBe(true);
  });

  it('stays silent between fires', () => {
    for (const n of [42, 43, 44, 45, 46, 47, 48, 49, 50]) {
      expect(shouldAlertRound(n, 40, 10)).toBe(false);
    }
  });

  it('repeats every N rounds after the first fire', () => {
    expect(shouldAlertRound(51, 40, 10)).toBe(true);
    expect(shouldAlertRound(61, 40, 10)).toBe(true);
  });

  it('threshold 0 disables the alert entirely', () => {
    for (const n of [1, 41, 100]) {
      expect(shouldAlertRound(n, 0, 10)).toBe(false);
    }
  });

  it('guard blocks the JS -0 === 0 trap below the threshold', () => {
    // 1 % 10 === 1, but (1-10-1) % 10 === -0 === 0 without the runCount >
    // threshold guard — this case is the regression 树懒 flagged in review.
    expect(shouldAlertRound(1, 10, 10)).toBe(false);
    expect(shouldAlertRound(11, 10, 10)).toBe(true);
  });
});
