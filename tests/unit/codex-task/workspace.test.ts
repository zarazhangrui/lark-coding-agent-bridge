import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeControllerWorkspace } from '../../../src/codex-task/workspace';

describe('initializeControllerWorkspace', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('installs a concise AGENTS.md and repo-scoped Codex task skill', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codex-controller-workspace-'));
    cleanup.push(workspace);

    const result = await initializeControllerWorkspace({ workspace });
    const agentsPath = join(workspace, 'AGENTS.md');
    const skillPath = join(workspace, '.agents', 'skills', 'codex-task-controller', 'SKILL.md');
    expect(result).toEqual({ workspace, created: [agentsPath, skillPath], skipped: [] });
    expect(await readFile(agentsPath, 'utf8')).toContain('主 task 的 cwd 始终保持为本目录');
    const skill = await readFile(skillPath, 'utf8');
    expect(skill).toContain('name: codex-task-controller');
    expect(skill).toContain('lark-channel-bridge codex-task send');
    expect(skill).toContain('Never edit Codex rollout JSONL');
    expect(skill).toContain('LARK_CHANNEL_BRIDGE_CONFIG');
    expect(skill).toContain('"${bridge_config_args[@]}"');
  });

  it('uses atomic no-clobber creation when initializers race without --force', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codex-controller-workspace-race-'));
    cleanup.push(workspace);

    const results = await Promise.all(Array.from(
      { length: 8 },
      () => initializeControllerWorkspace({ workspace }),
    ));
    const agentsPath = join(workspace, 'AGENTS.md');
    const skillPath = join(workspace, '.agents', 'skills', 'codex-task-controller', 'SKILL.md');

    expect(results.flatMap((result) => result.created).filter((path) => path === agentsPath)).toHaveLength(1);
    expect(results.flatMap((result) => result.created).filter((path) => path === skillPath)).toHaveLength(1);
    expect(results.flatMap((result) => result.skipped).filter((path) => path === agentsPath)).toHaveLength(7);
    expect(results.flatMap((result) => result.skipped).filter((path) => path === skillPath)).toHaveLength(7);
  });

  it('preserves existing local instructions unless force is explicit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codex-controller-workspace-'));
    cleanup.push(workspace);
    const agentsPath = join(workspace, 'AGENTS.md');
    await writeFile(agentsPath, 'local instructions\n', 'utf8');

    const first = await initializeControllerWorkspace({ workspace });
    expect(first.skipped).toContain(agentsPath);
    expect(await readFile(agentsPath, 'utf8')).toBe('local instructions\n');

    const forced = await initializeControllerWorkspace({ workspace, force: true });
    expect(forced.created).toContain(agentsPath);
    expect(await readFile(agentsPath, 'utf8')).toContain('飞书 Codex 主控工作区');
  });
});
