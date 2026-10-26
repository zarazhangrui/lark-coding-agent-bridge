import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';

// Skip fenced/inline code; recognize inline images with angle-bracket paths,
// escaped characters, optional titles and one level of parentheses in paths.
const MARKDOWN_TOKEN = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$|(`+)[^`]*?\2|!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]+>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))+)\s*(?:"[^"\n]*"|'[^'\n]*')?\s*\)/gm;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function readLocalImage(path: string, cwd: string): Promise<Buffer> {
  const [root, file] = await Promise.all([realpath(cwd), realpath(path)]);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('图片不在当前任务工作目录内');
  }
  if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
    throw new Error('不支持的图片格式');
  }
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error('图片必须是非空文件，且不超过 10 MB');
    }
    // Read a bounded buffer even if the file grows after stat().
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('图片在读取期间发生变化');
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

type PostElement =
  | { tag: 'md' | 'text'; text: string }
  | { tag: 'img'; image_key: string };

/** Parse the final Markdown directly; return undefined when no local image needs uploading. */
export async function buildLocalImagePost(input: {
  body: string;
  scope: string;
  cwd: string;
  uploadImage: (source: Buffer) => Promise<string>;
}): Promise<{ zh_cn: { title: string; content: PostElement[][] } } | undefined> {
  const uploaded = new Map<string, PostElement>();
  const content: PostElement[][] = [];
  let offset = 0;
  const appendText = (text: string) => {
    if (text.trim()) content.push([{ tag: 'md', text }]);
  };
  for (const match of input.body.matchAll(MARKDOWN_TOKEN)) {
    const target = match[4];
    if (target === undefined) continue;
    let path = target.replace(/^<|>$/g, '').replace(/\\([\\()[\] ])/g, '$1');
    if (/^file:/i.test(path)) {
      try { path = fileURLToPath(path); } catch { continue; }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !isAbsolute(path)) {
      continue;
    }
    if (path.startsWith('//') || path.startsWith('img_')) continue;
    path = resolve(input.cwd, path);
    let element = uploaded.get(path);
    if (!element) {
      try {
        const source = await readLocalImage(path, input.cwd);
        const imageKey = await input.uploadImage(source);
        if (!imageKey?.trim()) throw new Error('图片上传未返回 image_key');
        element = { tag: 'img', image_key: imageKey };
      } catch (err) {
        log.warn('outbound', 'image-upload-failed', {
          scope: input.scope,
          err: err instanceof Error ? err.message : String(err),
        });
        // Report failure in place so the rest of the answer remains deliverable.
        element = {
          tag: 'text',
          text: `图片「${match[3]?.trim() || '图片'}」上传失败，请检查文件是否位于当前任务工作目录、格式和大小，以及飞书上传权限。`,
        };
      }
      uploaded.set(path, element);
    }
    appendText(input.body.slice(offset, match.index));
    content.push([element]);
    offset = match.index + match[0].length;
  }
  if (uploaded.size === 0) return undefined;
  appendText(input.body.slice(offset));
  return { zh_cn: { title: '', content } };
}
