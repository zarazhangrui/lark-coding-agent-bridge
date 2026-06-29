import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { log } from '../../core/logger';

/**
 * Claude Code's `--print` mode accepts images only via `--input-format
 * stream-json`: a single `user` message on stdin whose `content` array carries
 * text plus one or more base64 image blocks (the standard Anthropic Messages
 * shape). There is no `--image` flag like codex has. This module turns the
 * text prompt + local image paths into that stdin payload.
 */

const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Anthropic rejects images whose base64 payload exceeds ~5MB. The bridge media
// policy already caps accepted images well below this, but guard anyway so a
// stray large file degrades to "path only" instead of failing the whole run.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function mediaTypeFor(path: string): string | undefined {
  return IMAGE_MEDIA_TYPE[extname(path).toLowerCase()];
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

type ContentBlock = TextBlock | ImageBlock;

/**
 * Read each image path and encode it as a base64 image block. Paths that can't
 * be read or have an unsupported extension are skipped (logged) rather than
 * aborting the run — the path still appears in the prompt JSON, so the agent
 * can fall back to reading it explicitly.
 */
export async function buildImageBlocks(paths: readonly string[]): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  for (const path of paths) {
    const mediaType = mediaTypeFor(path);
    if (!mediaType) {
      log.warn('agent', 'image-skip-mime', { path, reason: 'unsupported-extension' });
      continue;
    }
    try {
      const buf = await readFile(path);
      if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
        log.warn('agent', 'image-skip-size', { path, bytes: buf.byteLength });
        continue;
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
      });
    } catch (err) {
      log.warn('agent', 'image-skip-read', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return blocks;
}

/**
 * Build the newline-terminated stream-json user message to write to claude's
 * stdin. Returns null when there are no usable image blocks, signalling the
 * caller to stay on the plain `-p` text path (zero behaviour change).
 */
export async function buildStreamJsonInput(
  prompt: string,
  imagePaths: readonly string[],
): Promise<string | null> {
  const imageBlocks = await buildImageBlocks(imagePaths);
  if (imageBlocks.length === 0) return null;

  const content: ContentBlock[] = [{ type: 'text', text: prompt }, ...imageBlocks];
  const message = {
    type: 'user',
    message: { role: 'user', content },
  };
  return `${JSON.stringify(message)}\n`;
}
