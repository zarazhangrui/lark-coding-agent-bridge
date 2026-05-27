import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyAgentPreference } from '../../src/cli/agent-options';
import type { AppConfig } from '../../src/config/schema';

const baseConfig: AppConfig = {
  accounts: { app: { id: 'cli_xxx', secret: 'secret', tenant: 'feishu' } },
};

describe('applyAgentPreference', () => {
  it('lets an explicit CLI agent flag switch an existing config', async () => {
    const configPath = await tempConfigPath({
      ...baseConfig,
      preferences: { agent: 'claude', messageReply: 'card' },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const next = await applyAgentPreference(
        { ...baseConfig, preferences: { agent: 'claude', messageReply: 'card' } },
        configPath,
        'codex',
      );

      expect(next.preferences?.agent).toBe('codex');
      expect(next.preferences?.messageReply).toBe('card');

      const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as AppConfig;
      expect(onDisk.preferences?.agent).toBe('codex');
      expect(onDisk.preferences?.messageReply).toBe('card');
    } finally {
      log.mockRestore();
    }
  });

  it('leaves config untouched when no agent flag is provided', async () => {
    const configPath = await tempConfigPath({ ...baseConfig });
    const before = await readFile(configPath, 'utf8');

    const next = await applyAgentPreference({ ...baseConfig }, configPath, undefined);

    expect(next.preferences?.agent).toBeUndefined();
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });
});

async function tempConfigPath(cfg: AppConfig): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lark-agent-options-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return configPath;
}
