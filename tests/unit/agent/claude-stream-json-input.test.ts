import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStreamJsonInput } from '../../../src/agent/claude/stream-json-input.js';

const cleanups: Array<() => Promise<void>> = [];

async function tmpImage(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-img-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('buildStreamJsonInput', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('returns null when there are no image paths', async () => {
    expect(await buildStreamJsonInput('hello', [])).toBeNull();
  });

  it('builds a stream-json user message with text + base64 image block', async () => {
    const path = await tmpImage('a.png', PNG_BYTES);
    const payload = await buildStreamJsonInput('describe this', [path]);
    expect(payload).not.toBeNull();
    expect(payload!.endsWith('\n')).toBe(true);

    const msg = JSON.parse(payload!.trim());
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    const content = msg.message.content;
    expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(content[1].type).toBe('image');
    expect(content[1].source).toMatchObject({ type: 'base64', media_type: 'image/png' });
    expect(content[1].source.data).toBe(PNG_BYTES.toString('base64'));
  });

  it('maps known extensions to the right media type', async () => {
    const path = await tmpImage('a.jpg', PNG_BYTES);
    const payload = await buildStreamJsonInput('x', [path]);
    const msg = JSON.parse(payload!.trim());
    expect(msg.message.content[1].source.media_type).toBe('image/jpeg');
  });

  it('skips unsupported extensions and returns null when nothing usable remains', async () => {
    const path = await tmpImage('a.bmp', PNG_BYTES);
    expect(await buildStreamJsonInput('x', [path])).toBeNull();
  });

  it('skips unreadable paths and returns null', async () => {
    expect(await buildStreamJsonInput('x', ['/no/such/file.png'])).toBeNull();
  });

  it('skips empty files', async () => {
    const path = await tmpImage('empty.png', Buffer.alloc(0));
    expect(await buildStreamJsonInput('x', [path])).toBeNull();
  });
});
