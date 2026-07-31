import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { loadRootConfig, readActiveProfile } from '../config/profile-store';
import { CodexTaskController } from './controller';
import { CodexTaskRegistry } from './registry';

export interface ResolveCodexTaskContextOptions {
  profile?: string;
  rootDir?: string;
}

export interface CodexTaskContext {
  profile: string;
  profileConfig: ProfileConfig;
  appPaths: AppPaths;
  controller: CodexTaskController;
}

export async function resolveCodexTaskContext(
  options: ResolveCodexTaskContextOptions,
): Promise<CodexTaskContext> {
  const rootPaths = resolveAppPaths({ rootDir: options.rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  if (!root) throw new Error(`root config not found: ${rootPaths.configFile}`);
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
      configPath: appPaths.configFile,
      larkCliConfigDir: appPaths.larkCliConfigDir,
      larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
    },
  });
  return { profile, profileConfig, appPaths, controller };
}
