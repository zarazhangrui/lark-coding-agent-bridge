import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';

describe('ActiveRuns.waitForResume', () => {
  it('resolves true immediately when new runs are not paused', async () => {
    const activeRuns = new ActiveRuns();
    await expect(activeRuns.waitForResume(1000)).resolves.toBe(true);
  });

  it('resolves true as soon as the pause is released, without waiting out the timeout', async () => {
    const activeRuns = new ActiveRuns();
    const resume = activeRuns.pauseNewRuns('reconnect');

    const waiting = activeRuns.waitForResume(5000);
    setTimeout(() => resume(), 10);

    const start = Date.now();
    await expect(waiting).resolves.toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('resolves false once the timeout elapses while still paused', async () => {
    const activeRuns = new ActiveRuns();
    const resume = activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(activeRuns.waitForResume(20)).resolves.toBe(false);
      expect(activeRuns.newRunsPaused()).toBe(true);
    } finally {
      resume();
    }
  });

  it('resolves false immediately for a non-positive timeout while paused', async () => {
    const activeRuns = new ActiveRuns();
    const resume = activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(activeRuns.waitForResume(0)).resolves.toBe(false);
    } finally {
      resume();
    }
  });

  it('only resolves waiters once the last of several nested pauses is released', async () => {
    const activeRuns = new ActiveRuns();
    const resumeA = activeRuns.pauseNewRuns('reconnect-a');
    const resumeB = activeRuns.pauseNewRuns('reconnect-b');

    const waiting = activeRuns.waitForResume(5000);
    resumeA();
    // still paused by B — waiter must not have resolved yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(activeRuns.newRunsPaused()).toBe(true);

    resumeB();
    await expect(waiting).resolves.toBe(true);
  });

  it('does not leak a waiter entry after it resolves via resume', async () => {
    const activeRuns = new ActiveRuns();
    const resume = activeRuns.pauseNewRuns('reconnect');
    const waiting = activeRuns.waitForResume(5000);
    resume();
    await waiting;

    // A fresh pause/waitForResume cycle should behave normally — proves the
    // earlier waiter was cleaned up rather than firing again or throwing.
    const resumeAgain = activeRuns.pauseNewRuns('reconnect-again');
    const secondWait = activeRuns.waitForResume(20);
    await expect(secondWait).resolves.toBe(false);
    resumeAgain();
  });
});
