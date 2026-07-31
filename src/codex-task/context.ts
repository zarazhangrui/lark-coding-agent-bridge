import { dirname, resolve } from 'node:path';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { loadRootConfig, readActiveProfile } from '../config/profile-store';
import { CodexTaskController } from './controller';
import { CodexTaskRegistry } from './registry';

export interface ResolveCodexTaskContextOptions {
  config?: string;
  profile?: string;
  rootDir?: string;
}

export interface CodexTaskContext {
  profile: string;
  profileConfig: ProfileConfig;
  configPath: string;
  appPaths: AppPaths;
  controller: CodexTaskController;
}

export async function resolveCodexTaskContext(
  options: ResolveCodexTaskContextOptions,
): Promise<CodexTaskContext> {
  const configuredPath = nonEmpty(options.config)
    ?? (options.rootDir ? undefined : nonEmpty(process.env.LARK_CHANNEL_BRIDGE_CONFIG));
  const configPath = configuredPath ? resolve(configuredPath) : undefined;
  const rootPaths = resolveAppPaths({
    rootDir: options.rootDir ?? (configPath ? dirname(configPath) : undefined),
  });
  const actualConfigPath = configPath ?? rootPaths.configFile;
  const root = await loadRootConfig(actualConfigPath);
  if (!root) throw new Error(`root config not found: ${actualConfigPath}`);
  const profile = options.profile?.trim()
    || process.env.LARK_CHANNEL_PROFILE?.trim()
    || await readActiveProfile(rootPaths.rootDir)
    || root.activeProfile;
  if (!profile) throw new Error('profile is required');
  const profileConfig = root.profiles[profile];
  if (!profileConfig) throw new Error(`profile not found: ${profile}`);
  if (profileConfig.agentKind !== 'codex' || !profileConfig.codex) {
    throw new Error(`profile is not a Codex profile: ${profile}`);
  }
  if (profileConfig.codex.transport !== 'app-server') {
    throw new Error(`profile does not use Codex App Server transport: ${profile}`);
  }
  const appPaths = resolveAppPaths({ rootDir: rootPaths.rootDir, profile });
  const registry = new CodexTaskRegistry(appPaths.codexTasksFile);
  const controller = new CodexTaskController({
    binary: profileConfig.codex.binaryPath,
    profileStateDir: appPaths.profileDir,
    registry,
    ...(profileConfig.codex.codexHome ? { codexHome: profileConfig.codex.codexHome } : {}),
    inheritCodexHome: profileConfig.codex.inheritCodexHome === true,
    sandbox: profileConfig.sandbox.defaultMode,
    larkChannel: {
      profile,
      rootDir: appPaths.rootDir,
      configPath: actualConfigPath,
      larkCliConfigDir: appPaths.larkCliConfigDir,
      larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
    },
  });
  return { profile, profileConfig, configPath: actualConfigPath, appPaths, controller };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
