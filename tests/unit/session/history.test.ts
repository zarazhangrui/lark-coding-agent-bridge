import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';

describe('Claude local session history', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('uses Claude project directory encoding for punctuation in cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/Users/example/.lark-channel-workspaces/claude/default_open.sdks';
    const projectDir = join(
      home,
      '.claude',
      'projects',
      '-Users-example--lark-channel-workspaces-claude-default-open-sdks',
    );
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, 'session-a.jsonl');
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: 'user', message: { content: 'resume me' } })}\n`,
      'utf8',
    );
    await utimes(sessionPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    await expect(listRecentSessions(cwd, 5)).resolves.toEqual([
      {
        sessionId: 'session-a',
        mtime: Date.parse('2026-01-01T00:00:00Z'),
        preview: 'resume me',
        lineCount: 1,
      },
    ]);
  });

  it('summarizes bridge prompts using the real user input section', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/repo';
    const projectDir = join(home, '.claude', 'projects', '-repo');
    await mkdir(projectDir, { recursive: true });
    const prompt = buildAgentPrompt({
      context: {
        chatId: 'oc_secret',
        chatType: 'p2p',
        senderId: 'ou_secret',
        source: 'im',
      },
      instructions: ['internal bridge instruction'],
      userInput: '真实用户问题\n\n第二行',
    });
    await writeFile(
      join(projectDir, 'session-a.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`,
      'utf8',
    );

    const sessions = await listRecentSessions(cwd, 5);

    expect(sessions[0]?.preview).toBe('真实用户问题 第二行');
  });

  it('prefers the conversation title over the first user message', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/repo';
    const projectDir = join(home, '.claude', 'projects', '-repo');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-a.jsonl'),
      `${[
        JSON.stringify({ type: 'user', message: { content: 'OK read and understand my wiki' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Automated Content Pipeline' }),
        JSON.stringify({ type: 'custom-title', customTitle: 'My Pipeline' }),
      ].join('\n')}\n`,
      'utf8',
    );

    const sessions = await listRecentSessions(cwd, 5);
    // custom-title beats ai-title beats the first user message.
    expect(sessions[0]?.preview).toBe('My Pipeline');
  });

  it('falls back to ai-title when there is no custom-title', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/repo';
    const projectDir = join(home, '.claude', 'projects', '-repo');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-a.jsonl'),
      `${[
        JSON.stringify({ type: 'user', message: { content: 'first message' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Retrieve attendance data using lark CLI' }),
      ].join('\n')}\n`,
      'utf8',
    );

    const sessions = await listRecentSessions(cwd, 5);
    expect(sessions[0]?.preview).toBe('Retrieve attendance data using lark CLI');
  });
});
