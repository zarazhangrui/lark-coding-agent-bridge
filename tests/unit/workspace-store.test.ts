import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../../src/workspace/store.js';

describe('WorkspaceStore shared topic cwd', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('shares threaded workspaces across profile stores but keeps plain chats local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-workspaces-'));
    cleanup.push(root);
    const sharedDir = join(root, 'shared');
    const first = new WorkspaceStore(join(root, 'claude.json'), sharedDir);
    const second = new WorkspaceStore(join(root, 'codex.json'), sharedDir);
    await Promise.all([first.load(), second.load()]);
    const cwd = await realpath(root);

    first.setCwd('oc_chat:omt_topic', cwd);
    first.setCwd('oc_plain', '/claude-only');
    await first.flush();

    expect(second.cwdFor('oc_chat:omt_topic')).toBe(cwd);
    expect(second.cwdFor('oc_plain')).toBeUndefined();
  });
});
