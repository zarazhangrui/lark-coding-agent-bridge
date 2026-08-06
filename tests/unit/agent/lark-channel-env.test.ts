import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env';

describe('buildLarkChannelEnv', () => {
  const cleanup: string[] = [];
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const originalDataDir = process.env.LARKSUITE_CLI_DATA_DIR;
  const originalBinPath = process.env.LARK_CHANNEL_LARK_CLI_BIN;

  afterEach(async () => {
    restoreEnv('HOME', originalHome);
    restoreEnv('PATH', originalPath);
    restoreEnv('PATHEXT', originalPathExt);
    restoreEnv('LARKSUITE_CLI_DATA_DIR', originalDataDir);
    restoreEnv('LARK_CHANNEL_LARK_CLI_BIN', originalBinPath);
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('injects explicit lark-cli data and executable paths', () => {
    const larkCliDataDir = resolve('lark-cli-data');
    const larkCliBinPath = resolve('fake-bin', 'lark-cli');
    const env = buildLarkChannelEnv({
      larkCliDataDir,
      larkCliBinPath,
    });

    expect(env.LARKSUITE_CLI_DATA_DIR).toBe(larkCliDataDir);
    expect(env.LARK_CHANNEL_LARK_CLI_BIN).toBe(larkCliBinPath);
    expect(env.PATH?.split(delimiter)[0]).toBe(dirname(larkCliBinPath));
  });

  it.runIf(process.platform === 'linux')(
    'uses the account home for keychain data when the process HOME is isolated',
    () => {
      process.env.HOME = '/opt/isolated-agent/home';
      delete process.env.LARKSUITE_CLI_DATA_DIR;

      const env = buildLarkChannelEnv();

      expect(env.LARKSUITE_CLI_DATA_DIR).toBe(join(userInfo().homedir, '.local', 'share'));
      expect(env.LARKSUITE_CLI_DATA_DIR).not.toContain('/opt/isolated-agent/home');
    },
  );

  it('resolves lark-cli to an absolute path before spawning the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-lark-cli-env-'));
    cleanup.push(root);
    const binary = join(root, process.platform === 'win32' ? 'lark-cli.CMD' : 'lark-cli');
    await writeFile(
      binary,
      process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
      'utf8',
    );
    await chmod(binary, 0o755);
    process.env.PATH = root;
    if (process.platform === 'win32') process.env.PATHEXT = '.CMD';
    delete process.env.LARK_CHANNEL_LARK_CLI_BIN;

    const env = buildLarkChannelEnv();

    expect(env.LARK_CHANNEL_LARK_CLI_BIN).toBe(binary);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
