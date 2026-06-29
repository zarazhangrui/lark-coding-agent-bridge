import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listAntigravityConversationHistory } from '../../../src/session/antigravity-history.js';

describe('Antigravity session history', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('returns empty array when conversations directory does not exist', async () => {
    const dataDir = join(tmpdir(), `nonexistent-dir-${Math.random()}`);
    const results = await listAntigravityConversationHistory({ limit: 5, dataDir });
    expect(results).toEqual([]);
  });

  it('lists conversation history sorted by updatedAtMs descending', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'antigravity-history-test-'));
    cleanup.push(dataDir);
    const convDir = join(dataDir, 'conversations');
    await mkdir(convDir, { recursive: true });

    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';

    const path1 = join(convDir, `${id1}.db`);
    const path2 = join(convDir, `${id2}.pb`);

    await writeFile(path1, 'fake SQLite content');
    await writeFile(path2, 'fake protobuf content');

    // Set timestamps to control sorting order
    await utimes(path1, new Date('2026-01-01T12:00:00Z'), new Date('2026-01-01T12:00:00Z'));
    await utimes(path2, new Date('2026-01-01T13:00:00Z'), new Date('2026-01-01T13:00:00Z'));

    const results = await listAntigravityConversationHistory({ limit: 5, dataDir });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      conversationId: id2,
      source: 'local-proto',
    });
    expect(results[1]).toMatchObject({
      conversationId: id1,
      source: 'local-db',
    });
  });

  it('prefers db files over proto files for same conversation id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'antigravity-history-test-'));
    cleanup.push(dataDir);
    const convDir = join(dataDir, 'conversations');
    await mkdir(convDir, { recursive: true });

    const id = '11111111-1111-4111-8111-111111111111';

    const pathDb = join(convDir, `${id}.db`);
    const pathPb = join(convDir, `${id}.pb`);

    // pb is newer than db
    await writeFile(pathDb, 'fake SQLite content');
    await utimes(pathDb, new Date('2026-01-01T12:00:00Z'), new Date('2026-01-01T12:00:00Z'));

    await writeFile(pathPb, 'fake protobuf content');
    await utimes(pathPb, new Date('2026-01-01T13:00:00Z'), new Date('2026-01-01T13:00:00Z'));

    const results = await listAntigravityConversationHistory({ limit: 5, dataDir });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      conversationId: id,
      source: 'local-db', // Even though pb was newer, db was preferred or at least chosen correctly
    });
  });
});
