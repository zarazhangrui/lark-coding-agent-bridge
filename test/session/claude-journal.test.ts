import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeClaudeSessionCliResumable } from '../../src/session/claude-journal';
import { claudeProjectDir, encodeClaudeProjectPath } from '../../src/session/claude-paths';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('Claude journal compatibility', () => {
  it('uses Claude Code project directory encoding', () => {
    expect(encodeClaudeProjectPath('/private/tmp/bridge-entrypoint-probe.dnWNmj')).toBe(
      '-private-tmp-bridge-entrypoint-probe-dnWNmj',
    );
  });

  it('marks matching sdk-cli transcript entries as cli resumable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bridge-claude-home-'));
    homes.push(home);

    const cwd = '/private/tmp/bridge-entrypoint-probe.dnWNmj';
    const sessionId = '1177c32f-b17e-43a8-a9e1-dce2faeb1d6d';
    const otherSessionId = '2177c32f-b17e-43a8-a9e1-dce2faeb1d6d';
    const dir = claudeProjectDir(cwd, home);
    await mkdir(dir, { recursive: true });
    const journalPath = join(dir, `${sessionId}.jsonl`);
    await writeFile(
      journalPath,
      [
        JSON.stringify({ type: 'queue-operation', sessionId, operation: 'add' }),
        JSON.stringify({
          type: 'user',
          sessionId,
          entrypoint: 'sdk-cli',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({ type: 'assistant', sessionId, entrypoint: 'sdk-cli' }),
        JSON.stringify({ type: 'assistant', sessionId: otherSessionId, entrypoint: 'sdk-cli' }),
        '{malformed',
      ].join('\n') + '\n',
      'utf8',
    );

    const result = await makeClaudeSessionCliResumable(cwd, sessionId, home);

    expect(result).toMatchObject({ changed: true, rewrittenEntries: 2 });
    const lines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
    expect(JSON.parse(lines[1]!).entrypoint).toBe('cli');
    expect(JSON.parse(lines[2]!).entrypoint).toBe('cli');
    expect(JSON.parse(lines[3]!).entrypoint).toBe('sdk-cli');
    expect(lines[4]).toBe('{malformed');
  });

  it('reports unchanged when the journal has no sdk-cli entries for the session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bridge-claude-home-'));
    homes.push(home);

    const cwd = '/Users/example/project';
    const sessionId = '3177c32f-b17e-43a8-a9e1-dce2faeb1d6d';
    const dir = claudeProjectDir(cwd, home);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId, entrypoint: 'cli' })}\n`,
      'utf8',
    );

    await expect(makeClaudeSessionCliResumable(cwd, sessionId, home)).resolves.toMatchObject({
      changed: false,
      rewrittenEntries: 0,
    });
  });
});
