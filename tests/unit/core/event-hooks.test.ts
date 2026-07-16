import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEventHookAdapter } from '../../../src/core/event-hooks.js';
import { log } from '../../../src/core/logger.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('optional event hook adapter loading', () => {
  afterEach(async () => {
    delete process.env.LARK_CHANNEL_EVENT_HOOK_MODULE;
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('stays disabled when no module is configured', async () => {
    await expect(loadEventHookAdapter({ version: 'test' })).resolves.toBeUndefined();
  });

  it('loads handlers from an external module', async () => {
    const tmp = await createTmpProfile('event-hooks-');
    cleanups.push(tmp.cleanup);
    const adapterPath = join(tmp.root, 'event-hooks.mjs');
    await writeFile(
      adapterPath,
      `
        globalThis.__eventHookMeta = undefined;
        export function createEventHooks(meta) {
          globalThis.__eventHookMeta = meta;
          return {
            handlers: {
              'im.chat.member.user.deleted_v1': () => {},
            },
          };
        }
      `,
    );

    process.env.LARK_CHANNEL_EVENT_HOOK_MODULE = pathToFileURL(adapterPath).href;

    const adapter = await loadEventHookAdapter({
      version: '0.0.0-test',
      appId: 'cli_test',
      tenant: 'feishu',
      profile: 'default',
      configPath: '/tmp/config.json',
      hostname: 'host-a',
    });

    expect(globalThis.__eventHookMeta).toMatchObject({
      version: '0.0.0-test',
      appId: 'cli_test',
      tenant: 'feishu',
      profile: 'default',
      configPath: '/tmp/config.json',
      hostname: 'host-a',
    });
    expect(adapter?.handlers?.['im.chat.member.user.deleted_v1']).toEqual(expect.any(Function));
  });

  it('diagnoses bad modules without throwing', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const tmp = await createTmpProfile('event-hooks-bad-');
    cleanups.push(tmp.cleanup);
    const adapterPath = join(tmp.root, 'bad-event-hooks.mjs');
    await writeFile(adapterPath, 'export default { not: "a factory" };');

    process.env.LARK_CHANNEL_EVENT_HOOK_MODULE = pathToFileURL(adapterPath).href;

    await expect(loadEventHookAdapter({ version: 'test' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('eventHook', 'bad_module', {
      module: pathToFileURL(adapterPath).href,
    });
  });

  it('rejects a non-function close method', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const tmp = await createTmpProfile('event-hooks-bad-close-');
    cleanups.push(tmp.cleanup);
    const adapterPath = join(tmp.root, 'bad-close-event-hooks.mjs');
    await writeFile(
      adapterPath,
      'export default function () { return { handlers: {}, close: true }; }',
    );

    process.env.LARK_CHANNEL_EVENT_HOOK_MODULE = pathToFileURL(adapterPath).href;

    await expect(loadEventHookAdapter({ version: 'test' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('eventHook', 'bad_close', {
      module: pathToFileURL(adapterPath).href,
    });
  });
});

declare global {
  // eslint-disable-next-line no-var
  var __eventHookMeta: unknown;
}
