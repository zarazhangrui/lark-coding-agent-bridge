import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopStatusReporter,
  aggregateDesktopStatus,
  clampFloatingBallPosition,
  readDesktopStatusSnapshot,
} from '../../../src/desktop/status';

const tmpRoots: string[] = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-status-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop status snapshot', () => {
  it('aggregates to the highest-priority profile status', () => {
    expect(aggregateDesktopStatus([
      { status: 'idle' },
      { status: 'streaming' },
      { status: 'reconnecting' },
      { status: 'tool_running' },
    ])).toBe('reconnecting');
    expect(aggregateDesktopStatus([{ status: 'idle' }, { status: 'error' }])).toBe('error');
    expect(aggregateDesktopStatus([])).toBe('offline');
  });

  it('atomically writes one global snapshot for multiple profiles', async () => {
    const root = await tmpRoot();
    const first = new DesktopStatusReporter({
      rootDir: root,
      profile: 'claude-prod',
      agent: 'claude',
      appId: 'cli_1234567890',
    });
    const second = new DesktopStatusReporter({
      rootDir: root,
      profile: 'codex-dev',
      agent: 'codex',
      appId: 'cli_abcdef',
    });

    await first.update({ status: 'idle', botName: 'Ops Bot' });
    await second.update({ status: 'tool_running', activeRunCount: 1 });

    const snapshot = await readDesktopStatusSnapshot(root);
    expect(snapshot?.aggregateStatus).toBe('tool_running');
    expect(snapshot?.profiles.map((profile) => profile.profile)).toEqual(['claude-prod', 'codex-dev']);

    await second.clear();
    const cleaned = await readDesktopStatusSnapshot(root);
    expect(cleaned?.aggregateStatus).toBe('idle');
    expect(cleaned?.profiles.map((profile) => profile.profile)).toEqual(['claude-prod']);
  });

  it('does not serialize message bodies, ids, payloads, or credentials', async () => {
    const root = await tmpRoot();
    const reporter = new DesktopStatusReporter({
      rootDir: root,
      profile: 'safe',
      agent: 'codex',
      appId: 'cli_sensitive_app_id',
    });
    await reporter.update({
      status: 'error',
      botName: 'Bridge',
      activeRunCount: 1,
      queuedMessageCount: 2,
      lastErrorKind: 'agent',
    });

    const raw = await readFile(join(root, 'desktop-status.json'), 'utf8');
    for (const forbidden of [
      'message',
      'prompt',
      'payload',
      'chatId',
      'threadId',
      'sessionId',
      'senderId',
      'secret',
      'token',
      'cli_sensitive_app_id',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).toContain('"appIdSuffix": "app_id"');
  });

  it('clamps saved positions back into the visible frame', () => {
    const frame = { x: 100, y: 50, width: 400, height: 300 };
    expect(clampFloatingBallPosition({ x: 10, y: 900 }, frame)).toEqual({ x: 112, y: 294 });
    expect(clampFloatingBallPosition(undefined, frame)).toEqual({ x: 444, y: 62 });
  });
});
