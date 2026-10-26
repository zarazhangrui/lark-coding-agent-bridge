import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLocalImagePost } from '../../../src/bot/local-images';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-local-images-'));
  dirs.push(dir);
  return dir;
}
describe('local image replies', () => {
  it('resolves local paths without changing code or remote images', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'result (1).png'), 'image');
    await writeFile(join(cwd, 'other.png'), 'image');
    const code = '`![code](secret.png)`\n```md\n![example](secret.png)\n```';
    const remote = '![url](https://example.com/a.png) ![key](img_v3_abc)';
    const body = `Done\n![配置](<${join(cwd, 'result (1).png')}>)\n![again](./result\\ \\(1\\).png)\n![file](${pathToFileURL(join(cwd, 'other.png'))})\n${code}\n${remote}`;
    const uploadImage = vi.fn().mockResolvedValue('img_uploaded');
    const post = await buildLocalImagePost({ body, scope: 'scope', cwd, uploadImage });
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(post?.zh_cn.content.filter(row => row[0]?.tag === 'img')).toHaveLength(3);
    expect(post?.zh_cn.content.at(-1)).toEqual([{ tag: 'md', text: `\n${code}\n${remote}` }]);
    uploadImage.mockClear();
    expect(await buildLocalImagePost({ body: `${code}\n${remote}`, scope: 'scope', cwd, uploadImage })).toBeUndefined();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('preserves text/image order and repeated positions while uploading each file once', async () => {
    const cwd = await workspace();
    const bytes = Buffer.from('image fixture');
    await writeFile(join(cwd, 'one.png'), bytes);
    const uploadImage = vi.fn().mockResolvedValue('img_one');
    const body = 'Before\n![one](one.png)\nBetween\n![again](one.png)\nAfter';
    const post = await buildLocalImagePost({ body, scope: 'scope', cwd, uploadImage });
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadImage).toHaveBeenCalledWith(bytes);
    expect(post?.zh_cn.content).toEqual([
      [{ tag: 'md', text: 'Before\n' }],
      [{ tag: 'img', image_key: 'img_one' }],
      [{ tag: 'md', text: '\nBetween\n' }],
      [{ tag: 'img', image_key: 'img_one' }],
      [{ tag: 'md', text: '\nAfter' }],
    ]);
  });

  it('puts upload failures in place without losing text or later images', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'one.png'), 'image');
    await writeFile(join(cwd, 'two.png'), 'image');
    const uploadImage = vi.fn().mockRejectedValueOnce(new Error('upload denied')).mockResolvedValue('img_two');
    const body = 'Before ![one](one.png) Between ![two](two.png) After';
    const post = await buildLocalImagePost({ body, scope: 'scope', cwd, uploadImage });
    expect(post?.zh_cn.content).toEqual([
      [{ tag: 'md', text: 'Before ' }],
      [{ tag: 'text', text: expect.stringContaining('图片「one」上传失败') }],
      [{ tag: 'md', text: ' Between ' }],
      [{ tag: 'img', image_key: 'img_two' }],
      [{ tag: 'md', text: ' After' }],
    ]);
  });

  it('rejects missing files, directories, oversized files and symlinks outside the workspace', async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, 'private.png'), 'private');
    await symlink(join(outside, 'private.png'), join(cwd, 'link.png'));
    await writeFile(join(cwd, 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const uploadImage = vi.fn().mockResolvedValue('img_unexpected');
    const body = `![missing](missing.png) ![directory](.) ![big](big.png) ![link](link.png) ![outside](<${join(outside, 'private.png')}>)`;
    const post = await buildLocalImagePost({ body, scope: 'scope', cwd, uploadImage });
    expect(uploadImage).not.toHaveBeenCalled();
    expect(post?.zh_cn.content).toHaveLength(5);
    expect(post?.zh_cn.content.every(row => row[0]?.tag === 'text')).toBe(true);
  });
});
