import { readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { gcMediaCache, MediaCache } from '../../../src/media/cache.js';

const cleanups: Array<() => Promise<void>> = [];

describe('hash media attachment resolver', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('downloads message resources into content-hash paths without original names or file keys', async () => {
    const root = await tempDir();
    const bytes = Buffer.from('image-bytes');
    const cache = new MediaCache(fakeChannel(bytes), root);

    const [attachment] = await cache.resolve([
      {
        messageId: 'om_1',
        resource: {
          type: 'image',
          fileKey: 'img_secret_key',
          fileName: 'private name.png',
        } as never,
      },
    ]);

    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(attachment).toMatchObject({
      absPath: join(root, `${hash}.png`),
      path: join(root, `${hash}.png`),
      hash,
      mime: 'image/png',
      sourceMessageId: 'om_1',
      sourceFileKey: 'img_secret_key',
      originalName: 'private name.png',
      decision: 'accepted',
    });
    expect(attachment?.absPath).not.toContain('img_secret_key');
    expect(attachment?.absPath).not.toContain('private');
    expect(await readFile(attachment!.absPath, 'utf8')).toBe('image-bytes');
  });

  it('hashes downloaded resources without reading the full file into memory', async () => {
    const source = await readFile(new URL('../../../src/media/cache.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('readFile(tmpPath)');
    expect(source).toContain('createReadStream(path)');
  });

  it('garbage-collects old cache files by TTL', async () => {
    const root = await tempDir();
    const oldPath = join(root, 'old.bin');
    const freshPath = join(root, 'fresh.bin');
    await writeFile(oldPath, 'old');
    await writeFile(freshPath, 'fresh');
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(oldPath, oldTime, oldTime);

    await gcMediaCache(1_000, root);

    const files = await readdir(root);
    expect(files).toEqual(['fresh.bin']);
    expect((await stat(freshPath)).isFile()).toBe(true);
  });

  it('enforces cacheMaxBytes without deleting files from the current resolution', async () => {
    const root = await tempDir();
    const oldPath = join(root, 'old.bin');
    await writeFile(oldPath, 'old-cache-entry');
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(oldPath, oldTime, oldTime);

    const bytes = Buffer.from('fresh-image');
    const cache = new MediaCache(fakeChannel(bytes), root);
    const [attachment] = await cache.resolve(
      [
        {
          messageId: 'om_1',
          resource: { type: 'image', fileKey: 'img_secret_key' } as never,
        },
      ],
      { cacheMaxBytes: bytes.length },
    );

    await expect(stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(attachment!.absPath)).resolves.toMatchObject({ size: bytes.length });
  });

  it('removes current files that attachment policy rejects', async () => {
    const root = await tempDir();
    const bytes = Buffer.from('oversized-image');
    const cache = new MediaCache(fakeChannel(bytes), root);

    const [attachment] = await cache.resolve(
      [
        {
          messageId: 'om_1',
          resource: { type: 'image', fileKey: 'img_secret_key' } as never,
        },
      ],
      { imageMaxBytes: bytes.length - 1, cacheMaxBytes: bytes.length - 1 },
    );

    expect(attachment).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'image-too-large',
    });
    await expect(stat(attachment!.absPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function fakeChannel(bytes: Buffer) {
  return {
    async downloadResourceToFile(
      _messageId: string,
      _fileKey: string,
      _type: string,
      destPath: string,
    ) {
      await writeFile(destPath, bytes);
      return { contentType: 'image/png', bytesWritten: bytes.length };
    },
  } as never;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-resolver-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
