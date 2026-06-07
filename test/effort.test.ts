import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgentEffort,
  normalizeAgentEffort,
  type AppConfig,
} from '../src/config/schema';
import { SessionStore } from '../src/session/store';

const tempDirs: string[] = [];

async function tempSessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-effort-test-'));
  tempDirs.push(dir);
  return join(dir, 'sessions.json');
}

function minimalConfig(effort?: string): AppConfig {
  return {
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    preferences: effort ? { effort } : {},
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agent effort normalization', () => {
  it('accepts Claude Code supported effort levels', () => {
    expect(normalizeAgentEffort('low')).toBe('low');
    expect(normalizeAgentEffort('medium')).toBe('medium');
    expect(normalizeAgentEffort('high')).toBe('high');
    expect(normalizeAgentEffort('xhigh')).toBe('xhigh');
    expect(normalizeAgentEffort('max')).toBe('max');
  });

  it('maps user-friendly aliases to supported Claude Code levels', () => {
    expect(normalizeAgentEffort('extra high')).toBe('xhigh');
    expect(normalizeAgentEffort('extra-high')).toBe('xhigh');
    expect(normalizeAgentEffort('x_high')).toBe('xhigh');
    expect(normalizeAgentEffort('ultra')).toBe('max');
    expect(normalizeAgentEffort('ultra high')).toBe('max');
  });

  it('falls back to xhigh for invalid global config values', () => {
    expect(getAgentEffort(minimalConfig('low'))).toBe('low');
    expect(getAgentEffort(minimalConfig('not-a-level'))).toBe('xhigh');
    expect(getAgentEffort(minimalConfig())).toBe('xhigh');
  });
});

describe('SessionStore effort override', () => {
  it('persists effort-only entries and reloads them', async () => {
    const file = await tempSessionFile();
    const store = new SessionStore(file);

    store.setEffort('chat-a', 'low');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.getEffort('chat-a')).toBe('low');
    expect(reloaded.getRaw('chat-a')?.sessionId).toBeUndefined();
  });

  it('preserves effort when a Claude session id is recorded', async () => {
    const file = await tempSessionFile();
    const store = new SessionStore(file);

    store.setEffort('chat-a', 'max');
    store.set('chat-a', 'session-1', '/tmp/project');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.getEffort('chat-a')).toBe('max');
    expect(reloaded.resumeFor('chat-a', '/tmp/project')).toBe('session-1');
  });

  it('clears effort override without dropping resumable session state', async () => {
    const file = await tempSessionFile();
    const store = new SessionStore(file);

    store.set('chat-a', 'session-1', '/tmp/project');
    store.setEffort('chat-a', 'high');
    expect(store.clearEffortOverride('chat-a')).toBe(true);
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.getEffort('chat-a')).toBeUndefined();
    expect(reloaded.resumeFor('chat-a', '/tmp/project')).toBe('session-1');
  });

  it('clears session identity without dropping effort override', async () => {
    const file = await tempSessionFile();
    const store = new SessionStore(file);

    store.set('chat-a', 'session-1', '/tmp/project');
    store.setEffort('chat-a', 'medium');
    expect(store.clearSession('chat-a')).toBe(true);
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.resumeFor('chat-a', '/tmp/project')).toBeUndefined();
    expect(reloaded.getRaw('chat-a')?.sessionId).toBeUndefined();
    expect(reloaded.getRaw('chat-a')?.cwd).toBeUndefined();
    expect(reloaded.getEffort('chat-a')).toBe('medium');
  });

  it('drops the entry when clearing a session without scope preferences', async () => {
    const file = await tempSessionFile();
    const store = new SessionStore(file);

    store.set('chat-a', 'session-1', '/tmp/project');
    expect(store.clearSession('chat-a')).toBe(true);
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.getRaw('chat-a')).toBeUndefined();
  });
});
