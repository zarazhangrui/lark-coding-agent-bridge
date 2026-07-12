import { describe, expect, it } from 'vitest';
import { shouldEnableFloatingBall } from '../../../src/desktop/config';

describe('floating ball gating', () => {
  it('defaults on for macOS when unset', () => {
    expect(shouldEnableFloatingBall({ platform: 'darwin', cfg: {} })).toBe(true);
  });

  it('lets CLI disable override config', () => {
    expect(shouldEnableFloatingBall({
      platform: 'darwin',
      noFloatingBall: true,
      cfg: { desktop: { floatingBall: { enabled: true } } },
    })).toBe(false);
  });

  it('lets config disable macOS helper', () => {
    expect(shouldEnableFloatingBall({
      platform: 'darwin',
      cfg: { desktop: { floatingBall: { enabled: false } } },
    })).toBe(false);
  });

  it('forces non-macOS off', () => {
    expect(shouldEnableFloatingBall({
      platform: 'linux',
      cfg: { desktop: { floatingBall: { enabled: true } } },
    })).toBe(false);
    expect(shouldEnableFloatingBall({
      platform: 'win32',
      cfg: { desktop: { floatingBall: { enabled: true } } },
    })).toBe(false);
  });
});
