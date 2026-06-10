import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, ResourceDescriptor } from '@larksuite/channel';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import {
  normalizeAttachments,
  safeExtensionForMime,
  type AttachmentCandidate,
  type AttachmentKind,
  type AttachmentPolicyOptions,
  type NormalizedAttachment,
} from './attachment';

export type LocalAttachment = NormalizedAttachment;

export interface MediaResolveOptions extends Partial<AttachmentPolicyOptions> {
  cacheMaxBytes?: number;
}

export interface ResourceRequest {
  messageId: string;
  resource: ResourceDescriptor;
}

export class MediaCache {
  private readonly channel: LarkChannel;
  private readonly rootDir: string;

  constructor(channel: LarkChannel, rootDir: string = paths.mediaDir) {
    this.channel = channel;
    this.rootDir = rootDir;
  }

  async resolve(
    items: ResourceRequest[],
    options: MediaResolveOptions = {},
  ): Promise<LocalAttachment[]> {
    if (items.length === 0) return [];
    await mkdir(this.rootDir, { recursive: true });

    const candidates: AttachmentCandidate[] = [];
    for (const item of items) {
      try {
        const file = await this.resolveOne(item);
        if (file) candidates.push(file);
      } catch (err) {
        log.fail('media', err, { fileKey: item.resource.fileKey });
      }
    }
    const normalized = normalizeAttachments(candidates, options);
    await removeRejectedResolvedFiles(normalized);
    if (typeof options.cacheMaxBytes === 'number') {
      await enforceCacheMaxBytes(
        this.rootDir,
        options.cacheMaxBytes,
        new Set(
          normalized
            .filter((attachment) => attachment.decision === 'accepted')
            .map((attachment) => attachment.absPath),
        ),
      );
    }
    return normalized;
  }

  private async resolveOne(item: ResourceRequest): Promise<AttachmentCandidate | null> {
    const { messageId, resource: r } = item;
    if (r.type === 'sticker') {
      log.info('media', 'skip', { reason: 'sticker', fileKey: r.fileKey });
      return null;
    }
    const kind: AttachmentKind = r.type;
    const tmpPath = join(
      this.rootDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    // downloadResourceToFile hits im.v1.messageResource.get under the hood —
    // the endpoint required for resources that arrived in user messages. It
    // maps image resources to 'image' and everything else (file/audio/video)
    // to 'file'. We stream straight to disk (not via a full Buffer) because the
    // size limit is only enforced after download: a large attachment would
    // otherwise sit entirely in the JS heap before being rejected. It returns
    // the server content-type so we can pick an accurate extension, falling
    // back to defaultMime(kind) when absent.
    const { contentType } = await this.channel.downloadResourceToFile(
      messageId,
      r.fileKey,
      r.type === 'image' ? 'image' : 'file',
      tmpPath,
    );

    const tmpStat = await stat(tmpPath);
    const hash = await hashFile(tmpPath);
    const mime = contentType ?? defaultMime(kind);
    const ext = safeExtensionForMime(mime);
    const absPath = join(this.rootDir, `${hash}.${ext}`);
    try {
      await stat(absPath);
      await rm(tmpPath, { force: true });
      log.info('media', 'cache-hit', { path: absPath });
    } catch {
      await rename(tmpPath, absPath);
    }
    const candidate: AttachmentCandidate = {
      absPath,
      kind,
      size: tmpStat.size,
      mime,
      hash,
      source: 'lark',
      sourceMessageId: messageId,
      sourceFileKey: r.fileKey,
      ...(r.fileName ? { originalName: r.fileName } : {}),
    };
    log.info('media', 'downloaded', {
      path: candidate.absPath,
      size: candidate.size,
    });
    return candidate;
  }
}

/** Delete files under the media cache whose mtime is older than maxAgeMs. */
export async function gcMediaCache(
  maxAgeMs: number,
  root: string = paths.mediaDir,
): Promise<void> {
  try {
    await stat(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const files = await listFiles(root);
  for (const p of files) {
    try {
      const st = await stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await rm(p);
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  if (removed > 0) log.info('media', 'gc', { removed });
}

function defaultMime(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function enforceCacheMaxBytes(
  root: string,
  maxBytes: number,
  protectedPaths: ReadonlySet<string>,
): Promise<void> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const files = await Promise.all(
    (await listFiles(root)).map(async (path) => {
      const fileStat = await stat(path);
      return { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    }),
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files
    .filter((item) => !protectedPaths.has(item.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}

async function removeRejectedResolvedFiles(attachments: readonly NormalizedAttachment[]): Promise<void> {
  await Promise.all(
    attachments
      .filter((attachment) => attachment.decision !== 'accepted')
      .map((attachment) => rm(attachment.absPath, { force: true })),
  );
}
