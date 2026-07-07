import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mergeProcessEnv } from '../../../src/platform/spawn.js';

describe('platform spawn env', () => {
  it('overrides env keys case-insensitively for Windows-compatible CODEX_HOME handling', () => {
    const env = mergeProcessEnv(
      {
        Path: '/bin',
        Codex_Home: '/old-codex-home',
        LARK_CHANNEL: '0',
      },
      {
        CODEX_HOME: '/new-codex-home',
        LARK_CHANNEL: '1',
      },
    );

    expect(env.CODEX_HOME).toBe('/new-codex-home');
    expect(env.LARK_CHANNEL).toBe('1');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'codex_home')).toEqual([
      'CODEX_HOME',
    ]);
  });

  it('codex adapter uses cross-spawn without shell invocation', async () => {
    // The Claude adapter no longer spawns a child process at all -- it drives
    // the Claude Agent SDK's query() in-process (src/agent/claude/sdk-adapter.ts)
    // -- so the "no shell invocation" assertion is only meaningful for Codex now.
    const codexSource = await readFile(
      new URL('../../../src/agent/codex/adapter.ts', import.meta.url),
      'utf8',
    );

    expect(codexSource).toContain("from '../../platform/spawn'");
    expect(codexSource).not.toContain("from 'node:child_process'");
    expect(codexSource).not.toContain('shell: true');
  });

  it('Claude SDK adapter seeds process.env into the env passed to query()', async () => {
    const sdkAdapterSource = await readFile(
      new URL('../../../src/agent/claude/sdk-adapter.ts', import.meta.url),
      'utf8',
    );

    expect(sdkAdapterSource).toContain("from '../../platform/spawn'");
    expect(sdkAdapterSource).toContain('mergeProcessEnv(');
    expect(sdkAdapterSource).toContain('mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel))');
  });
});
