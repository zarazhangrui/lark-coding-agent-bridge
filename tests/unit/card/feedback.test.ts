import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardFeedback, respondToCardAction } from '../../../src/card/feedback';

describe('card callback receipt', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the actual action result without dropping its toast', async () => {
    const receipt = cardFeedback('已开始整理', 'success');
    expect(await respondToCardAction(async () => receipt, vi.fn())).toEqual(receipt);
  });

  it('turns a processing failure into a visible error and records it', async () => {
    const error = new Error('failed');
    const report = vi.fn();
    expect(await respondToCardAction(async () => { throw error; }, report)).toMatchObject({ toast: { type: 'error' } });
    expect(report).toHaveBeenCalledWith(error);
  });

  it('acknowledges slow work within the callback budget without claiming completion or dropping late errors', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const report = vi.fn();
    const result = respondToCardAction(() => new Promise((_resolve, fail) => { reject = fail; }), report);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual(cardFeedback('已收到点击，正在处理。请查看原卡片状态。'));
    const error = new Error('late failure');
    reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
