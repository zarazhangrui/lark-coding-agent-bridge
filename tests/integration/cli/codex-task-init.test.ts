import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodexTaskInit } from '../../../src/cli/commands/codex-task';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type CodexTransport,
} from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';

describe('codex-task init command', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('installs controller guidance into the configured profile workspace', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'codex-task-init-root-'));
    const workspace = await mkdtemp(join(tmpdir(), 'codex-task-init-workspace-'));
    cleanup.push(rootDir, workspace);
    await writeCodexProfile(rootDir, workspace, 'app-server');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCodexTaskInit({ rootDir, profile: 'codex', json: true });

    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      workspace: await realpath(workspace),
    });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toContain('飞书 Codex 主控工作区');
    expect(await readFile(
      join(workspace, '.agents', 'skills', 'codex-task-controller', 'SKILL.md'),
      'utf8',
    )).toContain('lark-channel-bridge codex-task');
  });

  it('rejects Codex profiles that do not use app-server transport', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'codex-task-init-root-'));
    const workspace = await mkdtemp(join(tmpdir(), 'codex-task-init-workspace-'));
    cleanup.push(rootDir, workspace);
    await writeCodexProfile(rootDir, workspace, 'exec');

    await expect(runCodexTaskInit({ rootDir, profile: 'codex' })).rejects.toThrow(
      /does not use Codex App Server transport/,
    );
  });
});

async function writeCodexProfile(
  rootDir: string,
  workspace: string,
  transport: CodexTransport,
): Promise<void> {
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } },
    codex: {
      binaryPath: 'codex',
      transport,
      inheritCodexHome: true,
    },
  });
  profile.workspaces.default = workspace;
  const root = createRootConfig('codex', profile);
  await saveRootConfig(root, resolveAppPaths({ rootDir }).configFile);
}
