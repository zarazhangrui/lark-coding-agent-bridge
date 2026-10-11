import { describe, expect, it } from 'vitest';
import { isProactiveObserverGloballyDisabled } from '../../../src/proactive/kill-switch';

describe('proactive observer global kill switch', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('treats %s as disabled', (value) => {
    expect(
      isProactiveObserverGloballyDisabled({ LARK_PROACTIVE_OBSERVER_DISABLED: value }),
    ).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'off'])('does not disable for %s', (value) => {
    expect(
      isProactiveObserverGloballyDisabled({
        ...(value === undefined ? {} : { LARK_PROACTIVE_OBSERVER_DISABLED: value }),
      }),
    ).toBe(false);
  });
});
