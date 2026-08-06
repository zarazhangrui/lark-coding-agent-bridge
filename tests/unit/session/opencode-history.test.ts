import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listOpencodeSessionHistory } from '../../../src/session/opencode-history.js';

describe('listOpencodeSessionHistory', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})),
    );
  });

  it('parses session list JSON and filters to matching cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hist-'));
    cleanup.push(dir);
    const targetCwd = '/home/user/project-a';
    const otherCwd = '/home/user/project-b';

    const sessions = [
      { id: 'ses_001', title: 'Fix bug in parser', directory: targetCwd, updated: 1700000100000, created: 1700000000000 },
      { id: 'ses_002', title: 'Add feature X', directory: otherCwd, updated: 1700000200000, created: 1700000050000 },
      { id: 'ses_003', title: 'Refactor utils', directory: targetCwd, updated: 1700000300000, created: 1700000080000 },
    ];

    const bin = join(dir, 'fake-opencode-sessions.mjs');
    // The script ignores args and outputs the JSON to stdout.
    await writeFile(
      bin,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(sessions))});\n`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const entries = await listOpencodeSessionHistory({ binary: bin, cwd: targetCwd, limit: 5 });
    expect(entries).toHaveLength(2);
    // Sorted by updatedAtMs descending: ses_003 is newest
    expect(entries[0]?.sessionId).toBe('ses_003');
    expect(entries[0]?.cwd).toBe(targetCwd);
    expect(entries[0]?.preview).toBe('Refactor utils');
    expect(entries[1]?.sessionId).toBe('ses_001');
  });

  it('returns [] when binary does not exist', async () => {
    const entries = await listOpencodeSessionHistory({
      binary: '/nonexistent/opencode-bin-xyz',
      cwd: '/tmp',
      limit: 5,
    });
    expect(entries).toEqual([]);
  });

  it('returns [] when JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hist-bad-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-opencode-bad.mjs');
    await writeFile(bin, '#!/usr/bin/env node\nprocess.stdout.write("not json");\n', 'utf8');
    await chmod(bin, 0o755);
    const entries = await listOpencodeSessionHistory({ binary: bin, cwd: '/tmp', limit: 5 });
    expect(entries).toEqual([]);
  });

  it('limits results to the requested count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hist-limit-'));
    cleanup.push(dir);
    const targetCwd = '/tmp/proj';
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      id: `ses_${i}`,
      title: `Session ${i}`,
      directory: targetCwd,
      updated: 1700000000000 + i * 1000,
      created: 1700000000000,
    }));
    const bin = join(dir, 'fake-opencode-limit.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(sessions))});\n`,
      'utf8',
    );
    await chmod(bin, 0o755);
    const entries = await listOpencodeSessionHistory({ binary: bin, cwd: targetCwd, limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('returns [] when binary exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hist-fail-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-opencode-fail.mjs');
    await writeFile(bin, '#!/usr/bin/env node\nprocess.exit(1);\n', 'utf8');
    await chmod(bin, 0o755);
    const entries = await listOpencodeSessionHistory({ binary: bin, cwd: '/tmp', limit: 5, timeoutMs: 2000 });
    expect(entries).toEqual([]);
  });
});
