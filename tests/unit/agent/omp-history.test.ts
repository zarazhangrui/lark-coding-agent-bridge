import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listOmpResumeHistory, ompSessionsDir } from '../../../src/session/omp-history';

describe('OMP resume history', () => {
  const dirs: string[] = [];
  const previous = process.env.PI_CODING_AGENT_DIR;

  afterEach(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('lists OMP sessions for a cwd and extracts the bridge user input preview', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'omp-history-'));
    dirs.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = await mkdtemp(join(tmpdir(), 'omp-history-cwd-'));
    dirs.push(cwd);
    const sessionsDir = ompSessionsDir(cwd);
    expect(sessionsDir).toBe(join(agentDir, 'sessions', `-tmp-${basename(cwd)}`));
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '01a0b4c8-1111-7222-8333-444455556666';
    await writeFile(
      join(sessionsDir, `2026-10-27T10-25-40-296Z_${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: sessionId,
          cwd,
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            attribution: 'agent',
            content: [{ type: 'text', text: 'internal reminder' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<bridge_context>\n{}\n</bridge_context>\n\n<user_input>\n{"text":"fix the parser"}\n</user_input>',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await listOmpResumeHistory(cwd, 5);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sessionId,
      preview: 'fix the parser',
      lineCount: 4,
    });
  });

  it('encodes home, temp, and absolute cwds the way OMP does', () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
    const suffix = (cwd: string) => ompSessionsDir(cwd).slice(join(agentDir, 'sessions').length + 1);

    expect(suffix(join(homedir(), 'a', 'b'))).toBe('-a-b');
    expect(suffix(join(tmpdir(), 'x', 'y'))).toMatch(/^-tmp-/);
    expect(suffix('/var/tmp/z')).toBe('--var-tmp-z--');
  });

  it('returns an empty list when the cwd has no OMP sessions', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'omp-history-empty-'));
    dirs.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    expect(await listOmpResumeHistory('/no/such/project', 5)).toEqual([]);
  });
});
