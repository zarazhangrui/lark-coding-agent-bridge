import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMulticaIssueCreate } from '../../../src/cli/commands/multica-issue';

type SpawnSyncMock = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

function spawnResult(status: number): SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  };
}

describe('runMulticaIssueCreate', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bridge-multica-issue-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('attaches a unique tail snapshot for Bug issues', async () => {
    const resultsDir = join(tempDir, 'results');
    await mkdir(resultsDir);
    await writeFile(join(resultsDir, 'old.log'), 'old log\n', 'utf8');
    const latest = join(resultsDir, 'latest.log');
    await writeFile(latest, Array.from({ length: 510 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8');
    await writeFile(join(resultsDir, 'newer.json'), '{"not":"a log"}\n', 'utf8');

    let snapshot = '';
    let attachmentPath = '';
    const captured = vi.fn<SpawnSyncMock>((command, args) => {
      const cliArgs = args as string[];
      attachmentPath = cliArgs[cliArgs.indexOf('--attachment') + 1] ?? '';
      snapshot = readFileSync(attachmentPath, 'utf8');
      return spawnResult(0);
    });
    const status = await runMulticaIssueCreate(['--title', 'Bug: tool call failed'], {
      resultsDir,
      spawnSync: captured,
    });

    expect(status).toBe(0);
    const args = captured.mock.calls[0]![1] as string[];
    expect(args.slice(0, 4)).toEqual(['issue', 'create', '--title', 'Bug: tool call failed']);
    expect(attachmentPath).toMatch(/bug-log-snapshot-\d+-\d+\.log$/);
    expect(snapshot.startsWith('line 11\n')).toBe(true);
    expect(snapshot).toContain('line 510');
    await expect(stat(attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not attach logs for non-Bug issues', async () => {
    const resultsDir = join(tempDir, 'results');
    await mkdir(resultsDir);
    await writeFile(join(resultsDir, 'latest.log'), 'TOOL_CALL\n', 'utf8');
    const captured = vi.fn<SpawnSyncMock>(() => spawnResult(0));

    await runMulticaIssueCreate(['--title', 'Add a settings page'], {
      resultsDir,
      spawnSync: captured,
    });

    const args = captured.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--attachment');
  });

  it('warns and continues without an attachment when no logs exist', async () => {
    const resultsDir = join(tempDir, 'missing-results');
    const captured = vi.fn<SpawnSyncMock>(() => spawnResult(0));
    const warn = vi.fn();

    const status = await runMulticaIssueCreate(['--title=Bug: broken'], {
      resultsDir,
      spawnSync: captured,
      warn,
    });

    expect(status).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no log file found'));
    const args = captured.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--attachment');
  });
});
