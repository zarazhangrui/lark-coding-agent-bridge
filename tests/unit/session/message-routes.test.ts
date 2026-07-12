import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageRouteStore } from '../../../src/session/message-routes.js';

const cleanups: Array<() => Promise<void>> = [];

describe('message route ledger', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records and looks up an outbound message → source scope mapping', async () => {
    const { store } = await makeStore();
    await store.record('om-1', { scope: 'chat-a', sessionId: 'sess-1', cwd: '/repo', ts: 1 });

    const route = await store.lookup('om-1');
    expect(route).toEqual({ scope: 'chat-a', sessionId: 'sess-1', cwd: '/repo', ts: 1 });
    expect(await store.lookup('om-missing')).toBeUndefined();
  });

  it('reads disk fresh so external writers can register their own entries', async () => {
    const { store, path } = await makeStore();
    await store.record('om-bridge', { scope: 'chat-a', ts: 1 });

    // Simulate an external notification tool appending to the same file.
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    disk['om-external'] = { scope: 'chat-b', sessionId: 'sess-b', cwd: '/other', ts: 2 };
    await writeFile(path, `${JSON.stringify(disk, null, 2)}\n`);

    // The bridge sees the external entry (disk is the source of truth)...
    expect(await store.lookup('om-external')).toMatchObject({ scope: 'chat-b' });
    // ...and a subsequent bridge record does not clobber it.
    await store.record('om-bridge-2', { scope: 'chat-a', ts: 3 });
    expect(await store.lookup('om-external')).toMatchObject({ scope: 'chat-b' });
    expect(await store.lookup('om-bridge')).toMatchObject({ scope: 'chat-a' });
  });

  it('evicts the oldest entries once the cap is exceeded', async () => {
    const { store } = await makeStore(2);
    await store.record('old', { scope: 's', ts: 1 });
    await store.record('mid', { scope: 's', ts: 2 });
    await store.record('new', { scope: 's', ts: 3 });

    expect(await store.lookup('old')).toBeUndefined();
    expect(await store.lookup('mid')).toMatchObject({ scope: 's' });
    expect(await store.lookup('new')).toMatchObject({ scope: 's' });
  });

  it('degrades to "no route" on a corrupt or missing ledger', async () => {
    const { store, path } = await makeStore();
    expect(await store.lookup('anything')).toBeUndefined();

    await writeFile(path, 'not json{');
    expect(await store.lookup('anything')).toBeUndefined();

    // A malformed entry (missing scope/ts) is ignored, not returned.
    await writeFile(path, JSON.stringify({ 'om-x': { cwd: '/repo' } }));
    expect(await store.lookup('om-x')).toBeUndefined();
  });
});

async function makeStore(
  maxEntries?: number,
): Promise<{ store: MessageRouteStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'message-routes-'));
  const path = join(dir, 'sessions.json.routes.json');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return { store: new MessageRouteStore(path, maxEntries), path };
}
