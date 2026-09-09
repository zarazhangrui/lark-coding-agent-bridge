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

  it('strips foreign agent-detection signals so lark-cli children stay in lark-channel context', () => {
    const env = mergeProcessEnv(
      {
        Path: '/bin',
        HERMES_HOME: '/Users/me/AppData/Local/hermes',
        OpenClaw_Home: '/opt/openclaw',
      },
      { LARK_CHANNEL: '1' },
    );

    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'hermes_home')).toEqual([]);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'openclaw_home')).toEqual([]);
    expect(env.Path).toBe('/bin');
    expect(env.LARK_CHANNEL).toBe('1');
  });

  it('adapters use cross-spawn without shell invocation', async () => {
    const [claudeSource, codexSource] = await Promise.all([
      readFile(new URL('../../../src/agent/claude/adapter.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/agent/codex/adapter.ts', import.meta.url), 'utf8'),
    ]);

    expect(claudeSource).toContain("from '../../platform/spawn'");
    expect(codexSource).toContain("from '../../platform/spawn'");
    expect(claudeSource).not.toContain("from 'node:child_process'");
    expect(codexSource).not.toContain("from 'node:child_process'");
    expect(claudeSource).not.toContain('shell: true');
    expect(codexSource).not.toContain('shell: true');
  });
});
