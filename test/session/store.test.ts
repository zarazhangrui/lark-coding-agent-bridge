import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/session/store';

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

async function makeStore(): Promise<SessionStore> {
  tmpRoot = await mkdtemp(join(tmpdir(), 'lark-channel-session-test-'));
  return new SessionStore(join(tmpRoot, 'sessions.json'));
}

describe('SessionStore', () => {
  it('only resumes sessions created by the same agent', async () => {
    const store = await makeStore();
    await store.load();

    store.set('chat-1', 'claude-session', '/repo', 'claude');
    await store.flush();

    const reloaded = new SessionStore(join(tmpRoot!, 'sessions.json'));
    await reloaded.load();

    expect(reloaded.resumeFor('chat-1', '/repo', 'claude')).toBe('claude-session');
    expect(reloaded.resumeFor('chat-1', '/repo', 'codex')).toBeUndefined();
  });

  it('treats legacy sessions without an agent marker as claude sessions', async () => {
    const store = await makeStore();
    await store.load();

    store.set('chat-1', 'legacy-session', '/repo');
    await store.flush();

    const reloaded = new SessionStore(join(tmpRoot!, 'sessions.json'));
    await reloaded.load();

    expect(reloaded.resumeFor('chat-1', '/repo', 'claude')).toBe('legacy-session');
    expect(reloaded.resumeFor('chat-1', '/repo', 'codex')).toBeUndefined();
  });
});
