import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardFeedback, respondToCardAction } from '../../../src/card/feedback';

describe('card callback receipt', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the actual action result without dropping its toast', async () => {
    const receipt = cardFeedback('已开始整理', 'success');
    const late = vi.fn();
    expect(await respondToCardAction(async () => receipt, vi.fn(), late)).toEqual(receipt);
    expect(late).not.toHaveBeenCalled();
  });

  it('delivers the final card after the provisional receipt instead of discarding it', async () => {
    vi.useFakeTimers();
    const final = { card: { type: 'raw', data: { schema: '2.0' } } };
    let finish!: (value: typeof final) => void;
    const late = vi.fn().mockResolvedValue(undefined);
    const result = respondToCardAction(() => new Promise(resolve => { finish = resolve; }), vi.fn(), late);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual(cardFeedback('已收到点击，正在处理。请查看原卡片状态。'));
    finish(final);
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(final);
  });

  it('records a failed delayed delivery without an unhandled rejection', async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof cardFeedback>) => void;
    const failure = new Error('delayed update failed');
    const report = vi.fn();
    const result = respondToCardAction(() => new Promise(resolve => { finish = resolve; }), report, async () => { throw failure; });
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    finish(cardFeedback('done'));
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
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
