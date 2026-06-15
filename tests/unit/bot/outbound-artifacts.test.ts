import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractOutboundFileCandidates,
  extractOutboundImageCandidates,
  resolveOutboundFileCandidates,
  resolveOutboundImageCandidates,
  sanitizeOutboundArtifactReferences,
  sendOutboundArtifacts,
} from '../../../src/bot/outbound-artifacts.js';
import type { RunState } from '../../../src/card/run-state.js';

describe('outbound artifacts', () => {
  it('extracts only markdown images and explicit bridge-file links from final text blocks', () => {
    const state = finalState(
      [
        'image: ![preview](renders/result.png) and plain screenshots/view.webp',
        'file: [model](bridge-file:outbound-files/deepsketch_example.3dm) plus reports/run.log',
        'source reference: [channel.ts](src/bot/channel.ts) and package.json',
        'ignore remote https://example.com/image.png',
      ].join('\n'),
    );

    expect(extractOutboundImageCandidates(state)).toEqual(['renders/result.png']);
    expect(extractOutboundFileCandidates(state)).toEqual(['outbound-files/deepsketch_example.3dm']);
  });

  it('sanitizes local artifact references while preserving surrounding text', () => {
    const state = finalState(
      [
        'before image',
        '![preview](renders/result.png)',
        'after image',
        '[model](bridge-file:outbound-files/deepsketch_example.3dm)',
        '[docs](src/bot/channel.ts)',
        '![remote](https://example.com/image.png)',
      ].join('\n'),
    );

    expect(sanitizeOutboundArtifactReferences(state).blocks).toEqual([
      {
        kind: 'text',
        streaming: false,
        content: [
          'before image',
          '图片已作为附件发送：preview',
          'after image',
          '文件已作为附件发送：model',
          '[docs](src/bot/channel.ts)',
          '![remote](https://example.com/image.png)',
        ].join('\n'),
      },
    ]);
  });

  it('resolves only workspace-contained image and non-image file candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'outbound-artifacts-'));
    const outside = await mkdtemp(join(tmpdir(), 'outbound-artifacts-outside-'));
    try {
      await mkdir(join(root, 'renders'));
      await mkdir(join(root, 'files'));
      const image = join(root, 'renders', 'result.png');
      const file = join(root, 'files', 'model.3dm');
      const outsideImage = join(outside, 'outside.png');
      await writeFile(image, Buffer.from([1, 2, 3]));
      await writeFile(file, Buffer.from([4, 5, 6]));
      await writeFile(outsideImage, Buffer.from([7, 8, 9]));

      await expect(resolveOutboundImageCandidates(['renders/result.png', outsideImage], root)).resolves.toEqual([
        image,
      ]);
      await expect(resolveOutboundFileCandidates(['files/model.3dm', 'renders/result.png'], root)).resolves.toEqual([
        file,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('sends resolved workspace images and files through the channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'outbound-artifacts-send-'));
    try {
      const image = join(root, 'preview.png');
      const file = join(root, 'model.3dm');
      await writeFile(image, Buffer.from([1, 2, 3]));
      await writeFile(file, Buffer.from([4, 5, 6]));
      const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
      const channel = {
        sender: { config: { allowedFileDirs: [] as string[] } },
        send: async (chatId: string, content: unknown, options: unknown) => {
          sent.push({ chatId, content, options });
        },
      };

      await sendOutboundArtifacts(
        channel as never,
        'oc_test',
        finalState(`![preview](preview.png)\n[model](bridge-file:model.3dm)`),
        root,
        { replyTo: 'om_test' },
      );

      expect(sent).toEqual([
        {
          chatId: 'oc_test',
          content: { image: { source: image } },
          options: { replyTo: 'om_test' },
        },
        {
          chatId: 'oc_test',
          content: { file: { source: file, fileName: 'model.3dm' } },
          options: { replyTo: 'om_test' },
        },
      ]);
      expect(channel.sender.config.allowedFileDirs).toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out stalled sends and continues with later artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'outbound-artifacts-timeout-'));
    try {
      const image = join(root, 'preview.png');
      const file = join(root, 'model.3dm');
      await writeFile(image, Buffer.from([1, 2, 3]));
      await writeFile(file, Buffer.from([4, 5, 6]));
      const sent: unknown[] = [];
      const channel = {
        sender: { config: { allowedFileDirs: [] as string[] } },
        send: async (_chatId: string, content: unknown) => {
          sent.push(content);
          if ((content as { image?: unknown }).image) {
            await new Promise(() => undefined);
          }
        },
      };

      await sendOutboundArtifacts(
        channel as never,
        'oc_test',
        finalState(`![preview](preview.png)\n[model](bridge-file:model.3dm)`),
        root,
        { replyTo: 'om_test' },
        { sendTimeoutMs: 5 },
      );

      expect(sent).toEqual([
        { image: { source: image } },
        { file: { source: file, fileName: 'model.3dm' } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function finalState(content: string): RunState {
  return {
    blocks: [{ kind: 'text', content, streaming: false }],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
  };
}
