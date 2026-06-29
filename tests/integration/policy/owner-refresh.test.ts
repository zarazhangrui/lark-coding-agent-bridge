import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnerRefreshController,
  refreshOwnerControls,
  type AppInfoSource,
} from '../../../src/policy/owner';
import { isCreator, type RuntimeControls } from '../../../src/policy/access';

describe('owner refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes bot owner from the application API', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeAppInfoSource(['ou_owner']);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls).toMatchObject({
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
    });
    expect(controls.ownerRefreshedAt).toBeTypeOf('number');
    expect(source.calls).toBe(1);
  });

  it('keeps cached owner available when a refresh fails', async () => {
    const controls: RuntimeControls = {
      botOwnerId: 'ou_previous',
      ownerRefreshState: 'ok',
    };
    const source = fakeAppInfoSource([new Error('permission denied')]);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls.botOwnerId).toBe('ou_previous');
    expect(controls.ownerRefreshState).toBe('failed');
    expect(controls.ownerRefreshError).toContain('permission denied');
    expect(isCreator(controls, 'ou_previous')).toBe(true);
  });

  it('fails closed when owner refresh fails without a cached owner', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeAppInfoSource([new Error('permission denied')]);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls.botOwnerId).toBeUndefined();
    expect(controls.ownerRefreshState).toBe('failed');
    expect(controls.ownerRefreshError).toContain('permission denied');
    expect(isCreator(controls, 'ou_previous')).toBe(false);
  });

  it('refreshes immediately and then every 30 minutes while the controller is running', async () => {
    vi.useFakeTimers();
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeAppInfoSource(['ou_first', 'ou_second']);
    const controller = createOwnerRefreshController({
      controls,
      source,
      appId: 'cli_test',
    });

    await controller.start();
    expect(controls.botOwnerId).toBe('ou_first');

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(controls.botOwnerId).toBe('ou_second');
    expect(source.calls).toBe(2);

    controller.stop();
  });
});

function fakeAppInfoSource(results: Array<string | Error>): AppInfoSource & { calls: number } {
  return {
    calls: 0,
    async getAppInfo() {
      this.calls += 1;
      const next = results.shift();
      if (next instanceof Error) throw next;
      return { ownerId: next };
    },
  };
}
