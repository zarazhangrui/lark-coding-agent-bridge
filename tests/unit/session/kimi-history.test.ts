import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listKimiResumeHistory } from '../../../src/session/kimi-history.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('listKimiResumeHistory', () => {
  it('maps a valid session list payload to summaries and passes the CLI contract', async () => {
    const { path: binary, recordPath } = await createFakeKimi(`
      import { writeFileSync } from "node:fs";
      writeFileSync("__RECORD_PATH__", JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(
        JSON.stringify([
          { id: 'session_a', updatedAt: 1_700_000_100_000, createdAt: 1_700_000_000_000 },
          { id: 'session_b', createdAt: 1_700_000_050_000 },
        ]),
      )});
    `);

    const summaries = await listKimiResumeHistory({ binary, cwd: '/repo/work', limit: 7 });

    expect(summaries).toEqual([
      { sessionId: 'session_a', mtime: 1_700_000_100_000, preview: '(Kimi 会话)', lineCount: 0 },
      // updatedAt missing → falls back to createdAt.
      { sessionId: 'session_b', mtime: 1_700_000_050_000, preview: '(Kimi 会话)', lineCount: 0 },
    ]);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual([
      'session',
      'list',
      '--cwd',
      '/repo/work',
      '--json',
      '--limit',
      '7',
    ]);
  });

  it('returns [] when the binary exits non-zero', async () => {
    const { path: binary } = await createFakeKimi(`
      console.log(${JSON.stringify(JSON.stringify([{ id: 'session_a' }]))});
      process.exit(3);
    `);

    await expect(listKimiResumeHistory({ binary, cwd: '/repo', limit: 5 })).resolves.toEqual([]);
  });

  it('returns [] when stdout is not JSON', async () => {
    const { path: binary } = await createFakeKimi(`
      console.log('not json at all');
    `);

    await expect(listKimiResumeHistory({ binary, cwd: '/repo', limit: 5 })).resolves.toEqual([]);
  });

  it('returns [] when stdout is a JSON object instead of an array', async () => {
    const { path: binary } = await createFakeKimi(`
      console.log(${JSON.stringify(JSON.stringify({ id: 'session_a' }))});
    `);

    await expect(listKimiResumeHistory({ binary, cwd: '/repo', limit: 5 })).resolves.toEqual([]);
  });

  it('skips entries without a string id and keeps the valid ones', async () => {
    const before = Date.now();
    const { path: binary } = await createFakeKimi(`
      console.log(${JSON.stringify(
        JSON.stringify([
          { createdAt: 1_700_000_000_000 },
          { id: '' },
          { id: 42 },
          null,
          { id: 'session_ok', updatedAt: 1_700_000_100_000 },
          { id: 'session_now' },
        ]),
      )});
    `);

    const summaries = await listKimiResumeHistory({ binary, cwd: '/repo', limit: 5 });

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      sessionId: 'session_ok',
      mtime: 1_700_000_100_000,
      preview: '(Kimi 会话)',
      lineCount: 0,
    });
    // Neither updatedAt nor createdAt → mtime falls back to now.
    expect(summaries[1]?.sessionId).toBe('session_now');
    expect(summaries[1]?.mtime).toBeGreaterThanOrEqual(before);
  });

  it('returns [] after timeoutMs when the binary hangs', async () => {
    const { path: binary } = await createFakeKimi(`
      setTimeout(() => {}, 60_000);
    `);

    await expect(
      listKimiResumeHistory({ binary, cwd: '/repo', limit: 5, timeoutMs: 300 }),
    ).resolves.toEqual([]);
  });

  it('returns [] when the binary does not exist', async () => {
    const missing = join(tmpdir(), `missing-kimi-${Date.now()}`);

    await expect(listKimiResumeHistory({ binary: missing, cwd: '/repo', limit: 5 })).resolves.toEqual(
      [],
    );
  });
});

async function createFakeKimi(script: string): Promise<{ path: string; recordPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-history-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const path = join(dir, 'fake-kimi.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    `#!${process.execPath}\n${script.replaceAll('__RECORD_PATH__', recordPath)}`,
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, recordPath };
}
