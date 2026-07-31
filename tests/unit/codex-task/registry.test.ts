import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTaskRegistry } from '../../../src/codex-task/registry';

describe('CodexTaskRegistry', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('registers, resolves, updates, and persists stable opaque handles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-task-registry-'));
    cleanup.push(dir);
    const path = join(dir, 'codex-tasks.json');
    const dates = [
      new Date('2026-07-31T08:00:00.000Z'),
      new Date('2026-07-31T08:01:00.000Z'),
    ];
    const registry = new CodexTaskRegistry(path, () => dates.shift()!, () => 'T-A1B2C3');

    const created = await registry.register({
      threadId: 'thread-1',
      title: ' Worker One ',
      cwd: '/tmp/project',
      model: 'gpt-test',
    });
    expect(created).toEqual({
      handle: 'T-A1B2C3',
      threadId: 'thread-1',
      title: 'Worker One',
      cwd: '/tmp/project',
      model: 'gpt-test',
      status: 'idle',
      createdAt: '2026-07-31T08:00:00.000Z',
      updatedAt: '2026-07-31T08:00:00.000Z',
    });
    expect(await registry.get('t-a1b2c3')).toEqual(created);

    const updated = await registry.update('T-A1B2C3', {
      status: 'completed',
      lastResult: 'done',
    });
    expect(updated).toMatchObject({
      handle: 'T-A1B2C3',
      status: 'completed',
      lastResult: 'done',
      updatedAt: '2026-07-31T08:01:00.000Z',
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      tasks: [updated],
    });
  });

  it('reuses a handle when the same durable thread is registered again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-task-registry-'));
    cleanup.push(dir);
    const registry = new CodexTaskRegistry(
      join(dir, 'codex-tasks.json'),
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-ABCDEF',
    );
    const first = await registry.register({ threadId: 'thread-1', title: 'First', cwd: '/tmp/a' });
    const second = await registry.register({ threadId: 'thread-1', title: 'Renamed', cwd: '/tmp/b' });

    expect(second.handle).toBe(first.handle);
    expect(second).toMatchObject({ title: 'Renamed', cwd: '/tmp/b' });
    expect(await registry.list()).toHaveLength(1);
  });

  it('serializes concurrent writers without losing updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-task-registry-'));
    cleanup.push(dir);
    const path = join(dir, 'codex-tasks.json');
    const first = new CodexTaskRegistry(
      path,
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-AAAAAA',
    );
    const second = new CodexTaskRegistry(
      path,
      () => new Date('2026-07-31T08:00:01.000Z'),
      () => 'T-BBBBBB',
    );

    const [left, right] = await Promise.all([
      first.register({ threadId: 'thread-left', title: 'Left', cwd: '/tmp/left' }),
      second.register({ threadId: 'thread-right', title: 'Right', cwd: '/tmp/right' }),
    ]);

    expect(new Set([left.handle, right.handle])).toEqual(new Set(['T-AAAAAA', 'T-BBBBBB']));
    expect(await first.list()).toHaveLength(2);
  });

  it('retries an opaque handle collision while holding the registry lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-task-registry-'));
    cleanup.push(dir);
    const path = join(dir, 'codex-tasks.json');
    const first = new CodexTaskRegistry(
      path,
      () => new Date('2026-07-31T08:00:00.000Z'),
      () => 'T-ABCDEF',
    );
    await first.register({ threadId: 'thread-left', title: 'Left', cwd: '/tmp/left' });
    const handles = ['T-ABCDEF', 'T-123456'];
    const second = new CodexTaskRegistry(
      path,
      () => new Date('2026-07-31T08:00:01.000Z'),
      () => handles.shift()!,
    );

    await expect(second.register({
      threadId: 'thread-right',
      title: 'Right',
      cwd: '/tmp/right',
    })).resolves.toMatchObject({ handle: 'T-123456' });
  });

  it('fails closed on damaged data and rejects malformed handles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-task-registry-'));
    cleanup.push(dir);
    const path = join(dir, 'codex-tasks.json');
    await writeFile(path, JSON.stringify([{ handle: 'bad', threadId: 'thread-1' }]), 'utf8');
    const registry = new CodexTaskRegistry(path);

    await expect(registry.list()).rejects.toThrow(/invalid Codex task registry/);
    await expect(registry.get('../bad')).rejects.toThrow(/invalid Codex task handle/);
  });
});
