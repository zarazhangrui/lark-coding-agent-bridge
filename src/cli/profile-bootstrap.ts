import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError } from '../agent/preflight';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  mimoBinaryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const codex =
    input.agentKind === 'codex'
      ? await createBootstrapCodexConfig(input.codexBinaryPath)
      : undefined;
  const mimo =
    input.agentKind === 'mimo'
      ? await createBootstrapMimoConfig(input.mimoBinaryPath)
      : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
    ...(mimo ? { mimo } : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapCodexConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function codexBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}

export async function createBootstrapMimoConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_MIMO_BIN ?? 'mimo';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: mimoBootstrapBinaryErrorCode(errno),
      agentId: 'mimo',
      agentName: 'MiMo Code',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function mimoBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
