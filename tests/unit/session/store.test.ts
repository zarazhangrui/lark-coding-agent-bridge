import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('topic context cursor persistence', () => {
  it('persists only message id and create time, independent of the agent session', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);

    store.setTopicCursor('oc_chat:omt_topic', {
      messageId: 'om_trigger',
      createTime: 1760000001000,
      recentMessageIds: ['om_trigger', 'om_previous'],
    });
    await store.flush();

    const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(persisted).toEqual({
      'oc_chat:omt_topic': {
        topicCursor: {
          messageId: 'om_trigger',
          createTime: 1760000001000,
          recentMessageIds: ['om_trigger', 'om_previous'],
        },
        updatedAt: expect.any(Number),
      },
    });

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getTopicCursor('oc_chat:omt_topic')).toEqual({
      messageId: 'om_trigger',
      createTime: 1760000001000,
      recentMessageIds: ['om_trigger', 'om_previous'],
    });
    expect(reloaded.resumeFor('oc_chat:omt_topic', '/repo')).toBeUndefined();
  });

  it('bounds persisted recent ids and never stores message bodies', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);
    const ids = Array.from({ length: 200 }, (_, index) => `om_${index}`);

    store.setTopicCursor('oc_chat:omt_topic', {
      messageId: 'om_trigger',
      createTime: 1760000001000,
      recentMessageIds: [...ids, 'om_0', ''],
    });
    await store.flush();

    const cursor = store.getTopicCursor('oc_chat:omt_topic');
    expect(cursor?.recentMessageIds).toHaveLength(128);
    expect(cursor?.recentMessageIds).toEqual(ids.slice(0, 128));
    expect(JSON.stringify(JSON.parse(await readFile(file, 'utf8')))).not.toContain('message body');
  });

  it('clears a topic cursor while preserving the existing idle-timeout override', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);
    store.setIdleTimeoutMinutes('oc_chat:omt_topic', 15);
    store.set('oc_chat:omt_topic', 'sess_existing', '/repo');
    store.setTopicCursor('oc_chat:omt_topic', {
      messageId: 'om_trigger',
      createTime: 1760000001000,
    });

    store.clear('oc_chat:omt_topic');

    expect(store.getTopicCursor('oc_chat:omt_topic')).toBeUndefined();
    expect(store.resumeFor('oc_chat:omt_topic', '/repo')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('oc_chat:omt_topic')).toBe(15);
    await store.flush();
  });

  it('ignores malformed persisted cursors', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);
    await writeFile(
      file,
      JSON.stringify({
        good: {
          updatedAt: 1,
          topicCursor: { messageId: 'om_good', createTime: 2 },
        },
        bad: {
          updatedAt: 1,
          topicCursor: { messageId: 'om_bad', createTime: 'not-a-number' },
        },
        empty: {
          updatedAt: 1,
          topicCursor: { messageId: 'om_empty', createTime: '' },
        },
      }),
    );

    await store.load();

    expect(store.getTopicCursor('good')).toEqual({ messageId: 'om_good', createTime: 2 });
    expect(store.getRaw('bad')).toBeUndefined();
    expect(store.getRaw('empty')).toBeUndefined();
  });
});

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-store-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'sessions.json');
}
