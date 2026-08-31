import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listRecentGrokSessions } from '../../../src/session/grok-history.js';

describe('listRecentGrokSessions', () => {
  const cleanup: string[] = [];
  const previousHome = process.env.GROK_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    await Promise.all(
      cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('returns an empty list when the grok session group is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'grok-home-'));
    cleanup.push(home);
    process.env.GROK_HOME = home;
    await expect(listRecentGrokSessions('/missing/cwd')).resolves.toEqual([]);
  });

  it('reads summary.json entries for the encoded working directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'grok-home-'));
    cleanup.push(home);
    process.env.GROK_HOME = home;
    const cwd = '/repo/app';
    const group = join(home, 'sessions', encodeURIComponent(cwd));
    const newer = join(group, 'sess-new');
    const older = join(group, 'sess-old');
    await mkdir(newer, { recursive: true });
    await mkdir(older, { recursive: true });
    await writeFile(
      join(older, 'summary.json'),
      JSON.stringify({
        info: { id: 'sess-old' },
        generated_title: 'Older task',
        updated_at: '2026-01-01T00:00:00Z',
        num_chat_messages: 2,
      }),
    );
    await writeFile(
      join(newer, 'summary.json'),
      JSON.stringify({
        info: { id: 'sess-new' },
        generated_title: 'Newer task',
        updated_at: '2026-02-01T00:00:00Z',
        num_chat_messages: 8,
      }),
    );

    await expect(listRecentGrokSessions(cwd, 5)).resolves.toEqual([
      {
        sessionId: 'sess-new',
        mtime: Date.parse('2026-02-01T00:00:00Z'),
        preview: 'Newer task',
        lineCount: 8,
      },
      {
        sessionId: 'sess-old',
        mtime: Date.parse('2026-01-01T00:00:00Z'),
        preview: 'Older task',
        lineCount: 2,
      },
    ]);
  });
});
