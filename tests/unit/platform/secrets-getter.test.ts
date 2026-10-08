import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSecretsGetterWrapper } from '../../../src/config/store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('secrets getter wrapper platform output', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('generates an executable POSIX shell wrapper', async () => {
    const root = await tmpRoot();
    const script = join(root, 'secrets-getter');

    const result = await ensureSecretsGetterWrapper(
      { rootDir: root, secretsGetterScript: script },
      { platform: 'darwin', nodePath: '/opt/node/bin/node', bridgeEntry: '/opt/bridge/bin.mjs' },
    );

    expect(result).toBe(script);
    const content = await readFile(script, 'utf8');
    expect(content).toContain('#!/bin/sh');
    expect(content).toContain(`LARK_CHANNEL_HOME='${root}'`);
    expect(content).toContain("'/opt/node/bin/node'");
    if (process.platform !== 'win32') {
      expect((await stat(script)).mode & 0o111).not.toBe(0);
    }
  });

  it('generates a Windows cmd wrapper instead of a shell script on win32', async () => {
    const root = await tmpRoot();
    const script = join(root, 'secrets-getter');

    const result = await ensureSecretsGetterWrapper(
      { rootDir: root, secretsGetterScript: script },
      {
        platform: 'win32',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        bridgeEntry: 'C:\\bridge\\bin\\bridge.mjs',
      },
    );

    expect(result).toBe(`${script}.cmd`);
    const content = await readFile(result, 'utf8');
    expect(content).toContain('@echo off');
    expect(content).toContain(`set "LARK_CHANNEL_HOME=${root}"`);
    expect(content).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(content).toContain('"C:\\bridge\\bin\\bridge.mjs" secrets get %*');
  });

  it('marks the win32 wrapper read-only so the lark-cli audit passes, and can still rewrite it', async () => {
    const root = await tmpRoot();
    const script = join(root, 'secrets-getter');
    const opts = {
      platform: 'win32' as const,
      nodePath: 'C:\\nodejs\\node.exe',
      bridgeEntry: 'C:\\bridge\\bin\\bridge.mjs',
    };

    const result = await ensureSecretsGetterWrapper({ rootDir: root, secretsGetterScript: script }, opts);
    // No write bits: on NTFS a writable file stats as 0666 and lark-cli's
    // AssertSecurePath rejects it as world-writable.
    expect((await stat(result)).mode & 0o222).toBe(0);

    // Rewrite must succeed despite the read-only bit (node path can move
    // between bridge runs) and must leave the file read-only again.
    const rewritten = await ensureSecretsGetterWrapper(
      { rootDir: root, secretsGetterScript: script },
      { ...opts, nodePath: 'D:\\other\\node.exe' },
    );
    expect(await readFile(rewritten, 'utf8')).toContain('"D:\\other\\node.exe"');
    expect((await stat(rewritten)).mode & 0o222).toBe(0);
  });
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'secrets-getter-'));
  await mkdir(root, { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}
