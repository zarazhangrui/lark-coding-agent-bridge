import { describe, expect, it } from 'vitest';
import { resolveFloatingBallHelperCandidates } from '../../../src/desktop/helper';

describe('floating ball helper resolution', () => {
  it('includes env override, packaged helper, and SwiftPM release paths', () => {
    const candidates = resolveFloatingBallHelperCandidates({
      LARK_CHANNEL_FLOATING_BALL_HELPER: '/tmp/custom-helper',
    });

    expect(candidates[0]).toBe('/tmp/custom-helper');
    expect(candidates.some((path) => path.endsWith('desktop/macos-floating-ball/LarkChannelFloatingBall'))).toBe(true);
    expect(candidates.some((path) =>
      /desktop\/macos-floating-ball\/\.build\/(arm64|x86_64)-apple-macosx\/release\/LarkChannelFloatingBall$/.test(path),
    )).toBe(true);
  });
});
