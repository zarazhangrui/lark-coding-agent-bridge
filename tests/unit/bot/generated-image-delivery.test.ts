import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GeneratedImageDelivery } from '../../../src/bot/generated-image-delivery.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('GeneratedImageDelivery', () => {
  it('sends a new stable image once and replies to the triggering message', async () => {
    const h = await createHarness();
    const delivery = h.delivery();
    delivery.start();

    const image = join(h.threadDir, 'exec-new.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    await waitFor(() => h.sent.some((item) => hasImage(item.content)));
    await delivery.stop();

    const imageMessages = h.sent.filter((item) => hasImage(item.content));
    expect(imageMessages).toEqual([
      {
        chatId: 'oc_test',
        content: { image: { source: image } },
        options: { replyTo: 'om_trigger' },
      },
    ]);
  });

  it('uses the final stop scan when a run ends immediately after image creation', async () => {
    const h = await createHarness();
    const delivery = h.delivery();
    delivery.start();

    const image = join(h.threadDir, 'exec-at-exit.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    await delivery.stop();

    expect(h.sent.filter((item) => hasImage(item.content))).toEqual([
      {
        chatId: 'oc_test',
        content: { image: { source: image } },
        options: { replyTo: 'om_trigger' },
      },
    ]);
  });

  it('ignores images that predate the current run', async () => {
    const h = await createHarness();
    const image = join(h.threadDir, 'exec-old.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    const old = new Date(Date.now() - 500);
    await utimes(image, old, old);

    const delivery = h.delivery({ startedAt: Date.now() });
    delivery.start();
    await delay(40);
    await delivery.stop();

    expect(h.sent).toEqual([]);
  });

  it('only observes the active Codex thread directory', async () => {
    const h = await createHarness();
    const otherDir = join(h.root, 'thread-other');
    await mkdir(otherDir);
    const delivery = h.delivery();
    delivery.start();

    await writeFile(join(otherDir, 'wrong.png'), Buffer.from([1]));
    await writeFile(join(h.threadDir, 'right.png'), Buffer.from([2]));
    await waitFor(() => h.sent.some((item) => hasImage(item.content)));
    await delivery.stop();

    expect(h.sent.filter((item) => hasImage(item.content))).toHaveLength(1);
    expect(h.sent[0]?.content).toEqual({ image: { source: join(h.threadDir, 'right.png') } });
  });

  it('rejects a thread directory symlink that escapes generated_images', async () => {
    const h = await createHarness();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'generated-image-outside-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'escape.png'), Buffer.from([1, 2, 3]));
    await symlink(outside, join(h.root, 'thread-link'), 'dir');

    const delivery = h.delivery({ initialThreadId: 'thread-link' });
    delivery.start();
    await delay(40);
    await delivery.stop();

    expect(h.sent).toEqual([]);
  });

  it('does not retry an ambiguous failed upload and emits one failure notice', async () => {
    const h = await createHarness({ failImages: true });
    const delivery = h.delivery();
    delivery.start();
    await writeFile(join(h.threadDir, 'failed.png'), Buffer.from([1, 2, 3]));

    await waitFor(() => h.sent.some((item) => hasMarkdown(item.content)));
    await delay(30);
    await delivery.stop();

    expect(h.imageAttempts).toBe(1);
    expect(h.sent.filter((item) => hasMarkdown(item.content))).toHaveLength(1);
  });
});

interface SentMessage {
  chatId: string;
  content: unknown;
  options: unknown;
}

interface DeliveryOverrides {
  startedAt?: number;
  initialThreadId?: string;
  stablePolls?: number;
}

async function createHarness(options: { failImages?: boolean } = {}): Promise<{
  root: string;
  threadDir: string;
  sent: SentMessage[];
  readonly imageAttempts: number;
  delivery(overrides?: DeliveryOverrides): GeneratedImageDelivery;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'generated-image-delivery-')));
  const threadDir = join(root, 'thread-current');
  await mkdir(threadDir);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sent: SentMessage[] = [];
  let imageAttempts = 0;
  const channel = {
    async send(chatId: string, content: unknown, optionsArg?: unknown): Promise<{ messageId: string }> {
      if (hasImage(content)) {
        imageAttempts++;
        if (options.failImages) throw new Error('ambiguous timeout');
      }
      sent.push({ chatId, content, options: optionsArg });
      return { messageId: `om_${sent.length}` };
    },
  };

  return {
    root,
    threadDir,
    sent,
    get imageAttempts() {
      return imageAttempts;
    },
    delivery(overrides = {}) {
      return new GeneratedImageDelivery({
        channel,
        chatId: 'oc_test',
        sendOpts: { replyTo: 'om_trigger' },
        rootDir: root,
        runId: 'run-test',
        startedAt: overrides.startedAt ?? Date.now() - 100,
        imageMaxBytes: 25 * 1024 * 1024,
        initialThreadId: overrides.initialThreadId ?? 'thread-current',
        pollIntervalMs: 5,
        stablePolls: overrides.stablePolls ?? 2,
      });
    },
  };
}

function hasImage(value: unknown): value is { image: { source: string } } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'image' in value &&
      (value as { image?: unknown }).image,
  );
}

function hasMarkdown(value: unknown): value is { markdown: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { markdown?: unknown }).markdown === 'string',
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
