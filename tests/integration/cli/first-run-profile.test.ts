import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstalledAgents, resolveExecutablePath } from '../../../src/cli/agent-detection';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-first-run-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('first-run profile bootstrap', () => {
  it('creates a Codex profile with a default workspace and inherited user Codex home', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    const profileDir = join(root, 'profiles', 'codex-dev');
    await mkdir(workspace, { recursive: true });
    const codex = await writeVersionExecutable(root, 'codex', 'codex 1.2.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      codexBinaryPath: codex,
      profileDir,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(profile.agentKind).toBe('codex');
    expect(profile.workspaces).toEqual({ default: workspaceRealpath });
    expect(profile.codex).toMatchObject({
      binaryPath: codex,
      inheritCodexHome: true,
    });
    expect(profile.codex?.realpath).toBeUndefined();
    expect(profile.codex?.version).toBeUndefined();
    expect(profile.codex?.sha256).toBeUndefined();
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
    await expect(stat(join(profileDir, 'codex-home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    const defaultWorkspace = join(root, 'managed-workspaces', 'codex-dev', 'default');
    const profileDir = join(root, 'profiles', 'codex-dev');
    const codex = await writeVersionExecutable(root, 'codex', 'codex 1.2.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' } },
      codexBinaryPath: codex,
      profileDir,
      defaultWorkspace,
    });

    const defaultWorkspaceRealpath = await realpath(defaultWorkspace);
    expect(profile.workspaces.default).toBe(defaultWorkspaceRealpath);
  });

  it('reports missing Codex bootstrap binaries as agent preflight diagnostics', async () => {
    const root = await makeRoot();
    const missing = join(root, 'missing-codex');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'codex',
        accounts: { app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' } },
        codexBinaryPath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: missing,
        binaryPath: missing,
      },
    });
  });

  it('creates a Trae profile with a default workspace and inherited user Trae home', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    const profileDir = join(root, 'profiles', 'trae-dev');
    await mkdir(workspace, { recursive: true });
    const trae = await writeVersionExecutable(root, 'traecli', 'traecli 0.200.13');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'trae',
      accounts: { app: { id: 'cli_trae', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      traeBinaryPath: trae,
      profileDir,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(profile.agentKind).toBe('trae');
    expect(profile.workspaces).toEqual({ default: workspaceRealpath });
    expect(profile.trae).toMatchObject({
      binaryPath: trae,
      inheritTraeHome: true,
    });
    await expect(stat(join(profileDir, 'trae-home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a requested bootstrap workspace is not a directory', async () => {
    const root = await makeRoot();
    const file = join(root, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'claude',
        accounts: { app: { id: 'cli_claude', secret: '${APP_SECRET}', tenant: 'feishu' } },
        workspace: file,
      }),
    ).rejects.toThrow(/路径不是目录/);
  });

  it('accepts a requested bootstrap workspace without requiring git', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const profile = await createBootstrapProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_claude', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
    });

    await expect(realpath(workspace)).resolves.toBe(profile.workspaces.default);
  });

  it('leaves workspaces empty when neither explicit nor managed workspace is provided', async () => {
    await expect(
      createBootstrapProfileConfig({
        agentKind: 'claude',
        accounts: { app: { id: 'cli_claude', secret: '${APP_SECRET}', tenant: 'feishu' } },
      }),
    ).resolves.toMatchObject({
      workspaces: {},
    });
  });

  it('detects available agents from PATH without inventing missing tools', async () => {
    const root = await makeRoot();
    const codex = await writeVersionExecutable(root, 'codex', 'codex 1.2.3');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    const oldTrae = process.env.LARK_CHANNEL_TRAE_BIN;
    process.env.PATH = root;
    process.env.LARK_CHANNEL_CLAUDE_BIN = 'missing-claude';
    process.env.LARK_CHANNEL_CODEX_BIN = process.platform === 'win32' ? codex : 'codex';
    process.env.LARK_CHANNEL_TRAE_BIN = 'missing-trae';
    try {
      await expect(detectInstalledAgents()).resolves.toEqual([
        { kind: 'codex', binaryPath: codex },
      ]);
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
      if (oldTrae === undefined) {
        delete process.env.LARK_CHANNEL_TRAE_BIN;
      } else {
        process.env.LARK_CHANNEL_TRAE_BIN = oldTrae;
      }
    }
  });

  it('resolves Windows-style PATHEXT command shims from PATH', async () => {
    const root = await makeRoot();
    await writeExecutable(root, 'codex.cmd', '@echo off\r\necho codex 1.2.3\r\n');
    const oldPath = process.env.PATH;
    const oldPathExt = process.env.PATHEXT;
    process.env.PATH = root;
    process.env.PATHEXT = '.cmd;.exe';
    try {
      await expect(resolveExecutablePath('codex')).resolves.toBe(join(root, 'codex.cmd'));
    } finally {
      process.env.PATH = oldPath;
      if (oldPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = oldPathExt;
      }
    }
  });
});

async function writeExecutable(root: string, name: string, content: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, content, { mode: 0o755 });
  return file;
}
