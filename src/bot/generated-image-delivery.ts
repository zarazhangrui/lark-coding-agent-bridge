import type { LarkChannel, SendOptions } from '@larksuite/channel';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { log } from '../core/logger';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_STABLE_POLLS = 2;
const DEFAULT_MAX_IMAGES = 6;

interface CandidateState {
  size: number;
  mtimeMs: number;
  stablePolls: number;
}

export interface GeneratedImageDeliveryOptions {
  channel: Pick<LarkChannel, 'send'>;
  chatId: string;
  sendOpts: SendOptions;
  rootDir: string;
  runId: string;
  startedAt: number;
  imageMaxBytes: number;
  initialThreadId?: string;
  pollIntervalMs?: number;
  stablePolls?: number;
  maxImages?: number;
}

/**
 * Watches the current Codex thread's generated_images directory and sends new
 * images directly to Feishu. This path is intentionally independent of Codex's
 * JSONL completion: image-generation tool output can contain several megabytes
 * of base64 and may take minutes to POST back to the model after the PNG is
 * already safely on disk.
 */
export class GeneratedImageDelivery {
  private readonly channel: Pick<LarkChannel, 'send'>;
  private readonly chatId: string;
  private readonly sendOpts: SendOptions;
  private readonly rootDir: string;
  private readonly runId: string;
  private readonly startedAt: number;
  private readonly imageMaxBytes: number;
  private readonly pollIntervalMs: number;
  private readonly requiredStablePolls: number;
  private readonly maxImages: number;
  private readonly candidates = new Map<string, CandidateState>();
  private readonly delivered = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly ignored = new Set<string>();
  private threadId: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private failureNoticeSent = false;

  constructor(options: GeneratedImageDeliveryOptions) {
    this.channel = options.channel;
    this.chatId = options.chatId;
    this.sendOpts = options.sendOpts;
    this.rootDir = resolve(options.rootDir);
    this.runId = options.runId;
    this.startedAt = options.startedAt;
    this.imageMaxBytes = options.imageMaxBytes;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requiredStablePolls = options.stablePolls ?? DEFAULT_STABLE_POLLS;
    this.maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
    if (options.initialThreadId) this.setThreadId(options.initialThreadId);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  setThreadId(threadId: string): void {
    if (!isSafeThreadId(threadId)) {
      log.warn('media', 'generated-image-thread-rejected', { runId: this.runId });
      return;
    }
    if (this.threadId === threadId) return;
    this.threadId = threadId;
    this.candidates.clear();
    this.ignored.clear();
    if (this.started && !this.stopped) this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.polling;
    // A run can terminate immediately after image creation. Finish the same
    // stability checks synchronously so that the last image is not missed, but
    // never bypass them: sending a file that is still being written would be
    // worse than omitting it.
    await this.pollOnce();
    for (
      let poll = 1;
      poll < this.requiredStablePolls && this.candidates.size > 0;
      poll++
    ) {
      await delay(this.pollIntervalMs);
      await this.pollOnce();
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = this.pollOnce()
        .catch((err) => {
          log.fail('media', err, { step: 'generated-image-poll', runId: this.runId });
        })
        .finally(() => {
          this.polling = undefined;
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.threadId || this.delivered.size >= this.maxImages) return;
    const unresolvedThreadDir = resolveThreadDir(this.rootDir, this.threadId);
    if (!unresolvedThreadDir) return;

    // Canonicalize both sides before the containment check. On macOS, paths
    // created below /var resolve to /private/var; comparing one canonical path
    // with one lexical path would reject every legitimate generated image.
    // Checking the canonical thread directory also prevents a symlinked thread
    // directory from escaping generated_images.
    const [canonicalRootDir, threadDir] = await Promise.all([
      realpath(this.rootDir).catch(() => undefined),
      realpath(unresolvedThreadDir).catch(() => undefined),
    ]);
    if (!canonicalRootDir || !threadDir || !isPathInside(threadDir, canonicalRootDir)) return;

    let entries;
    try {
      entries = await readdir(threadDir, { withFileTypes: true });
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (this.delivered.size >= this.maxImages) return;
      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const candidatePath = resolve(threadDir, entry.name);
      if (
        this.delivered.has(candidatePath) ||
        this.failed.has(candidatePath) ||
        this.ignored.has(candidatePath)
      ) {
        continue;
      }

      const info = await stat(candidatePath).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (info.size <= 0) continue;
      if (info.size > this.imageMaxBytes || info.mtimeMs < this.startedAt) {
        this.ignored.add(candidatePath);
        this.candidates.delete(candidatePath);
        continue;
      }

      const previous = this.candidates.get(candidatePath);
      const stablePolls =
        previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs
          ? previous.stablePolls + 1
          : 1;
      this.candidates.set(candidatePath, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        stablePolls,
      });
      if (stablePolls < this.requiredStablePolls) continue;

      const imagePath = await realpath(candidatePath).catch(() => undefined);
      if (!imagePath || !isPathInside(imagePath, threadDir)) {
        this.failed.add(candidatePath);
        this.candidates.delete(candidatePath);
        continue;
      }

      try {
        const result = await this.channel.send(
          this.chatId,
          { image: { source: imagePath } },
          this.sendOpts,
        );
        this.delivered.add(candidatePath);
        this.candidates.delete(candidatePath);
        log.info('media', 'generated-image-sent', {
          runId: this.runId,
          bytes: info.size,
          messageId: result?.messageId,
          replyTo: this.sendOpts.replyTo,
          replyInThread: this.sendOpts.replyInThread === true,
        });
      } catch (err) {
        // Do not retry here: an HTTP timeout can mean Feishu accepted the
        // message but the acknowledgement was lost, and retrying would create
        // the duplicate-image failure this fast path is meant to avoid.
        this.failed.add(candidatePath);
        this.candidates.delete(candidatePath);
        log.fail('media', err, {
          step: 'generated-image-send',
          runId: this.runId,
          bytes: info.size,
        });
        await this.sendFailureNotice();
      }
    }
  }

  private async sendFailureNotice(): Promise<void> {
    if (this.failureNoticeSent) return;
    this.failureNoticeSent = true;
    await this.channel
      .send(
        this.chatId,
        { markdown: '图片已经生成，但自动上传到飞书失败。为避免重复发送，Bot 没有自动重试。' },
        this.sendOpts,
      )
      .catch(() => undefined);
  }
}

function resolveThreadDir(rootDir: string, threadId: string): string | undefined {
  const resolved = resolve(rootDir, threadId);
  return isPathInside(resolved, rootDir) ? resolved : undefined;
}

function isPathInside(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function isSafeThreadId(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
