import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as p from '@clack/prompts';
import { runRegistrationWizard } from '../bot/wizard';
import { detectInstalledAgents, type DetectedAgent } from '../cli/agent-detection';
import {
  createBootstrapCodexConfig,
  createBootstrapProfileConfig,
  resolveBootstrapWorkspace,
} from '../cli/profile-bootstrap';
import { promptPassword } from '../cli/prompt';
import { setSecret } from '../config/keystore';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import {
  ActiveBridgeMigrationConflictError,
  collectLegacyDefaultWorkspace,
  migrateV1ToV2,
  type MigrateV2Options,
} from '../config/migrate-v2';
import {
  agentKindFromString,
  createRootConfig,
  hasPermissionDefaultsMigration,
  loadRootConfig,
  markPermissionDefaultsMigration,
  readActiveProfile,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../config/profile-store';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type CreateDefaultProfileConfigInput,
  type ProfileConfig,
  type RootConfig,
} from '../config/profile-schema';
import { permissionsToLegacySandbox } from '../config/permissions';
import type { AppConfig, SecretInput, TenantBrand } from '../config/schema';
import { isComplete, isSecretRef, secretKeyForApp } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import {
  buildEncryptedAccountConfig,
  ensureSecretsGetterWrapper,
  loadConfig,
  saveConfig,
} from '../config/store';
import { log } from '../core/logger';
import {
  hasLegacyLarkCliSourceOverlay,
  recoverLegacyLarkCliSourceOverlay,
} from '../lark-cli/legacy-source-overlay';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface ResolveProfileRuntimeOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  allowBootstrap?: boolean;
  selectAgent?: (detected: DetectedAgent[]) => AgentKind | undefined | Promise<AgentKind | undefined>;
  handleActiveBridgeMigrationConflict?: (
    err: ActiveBridgeMigrationConflictError,
  ) => boolean | Promise<boolean>;
}

export interface ProfileRuntime {
  cfg: AppConfig & { agentKind?: AgentKind };
  profileConfig: ProfileConfig;
  configPath: string;
  appPaths: AppPaths;
  profile: string;
}

export interface MaterializeEnvSecretForServiceOptions {
  config?: string;
  profile?: string;
}

const ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

export function createRuntimeProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return createDefaultProfileConfig({
    ...input,
    ...(input.agentKind === 'codex'
      ? { codex: input.codex ?? { binaryPath: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' } }
      : {}),
    ...(input.agentKind === 'pi'
      ? { pi: input.pi ?? { binaryPath: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' } }
      : {}),
  });
}

export async function resolveProfileRuntime(
  opts: ResolveProfileRuntimeOptions,
): Promise<ProfileRuntime> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const recoveryConfigFile = opts.config ?? resolveAppPaths({ rootDir }).configFile;
  if (await hasLegacyLarkCliSourceOverlay(recoveryConfigFile)) {
    await recoverLegacyLarkCliSourceOverlay(recoveryConfigFile);
  }
  const requestedAgent = agentKindFromString(opts.agent);
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? requestedAgent;
  if (!profile && opts.allowBootstrap) {
    const detected = await detectInstalledAgents();
    if (detected.length === 0) {
      throw new Error('no supported local agent found; install claude or codex first');
    }
    if (detected.length > 1) {
      const selected = await selectDetectedAgent(detected, opts.selectAgent);
      if (!selected) {
        throw new Error(formatAmbiguousAgentSelectionError(detected));
      }
      profile = selected;
    } else {
      profile = detected[0]?.kind;
    }
  }
  if (!profile && !opts.allowBootstrap) {
    throw new Error('active profile is required');
  }
  profile ??= 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const migrationAgent = resolveBootstrapAgent(requestedAgent, profile);
  const needsMigration = await hasLegacyConfig(configPath);
  await migrateV1ToV2WithActiveBridgeHandling({
    rootDir: appPaths.rootDir,
    profile: appPaths.profile,
    configFile: configPath,
    workspace: opts.workspace,
    ...(migrationAgent ? { agentKind: migrationAgent } : {}),
    ...(needsMigration && migrationAgent === 'codex'
      ? { codex: await createBootstrapCodexConfig(undefined) }
      : {}),
  }, opts.handleActiveBridgeMigrationConflict);

  let rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    let profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile,
          requestedAgent,
          opts,
          appPaths,
          configPath,
        });
      }
      throw new Error(`profile not found: ${profile}`);
    }
    assertRequestedAgentMatchesExistingProfile(profile, profileConfig, requestedAgent);
    const runtimeUpgrade = upgradeLegacyRuntimeDefaults(rootConfig, profile);
    if (runtimeUpgrade.changed) {
      rootConfig = runtimeUpgrade.rootConfig;
    }
    const defaultWorkspaceUpgrade = await ensureProfileDefaultWorkspace(rootConfig, profile, appPaths);
    if (defaultWorkspaceUpgrade.changed) {
      rootConfig = defaultWorkspaceUpgrade.rootConfig;
    }
    if (runtimeUpgrade.changed || defaultWorkspaceUpgrade.changed) {
      await saveRootConfig(rootConfig, configPath);
      profileConfig = rootConfig.profiles[profile]!;
      log.info('profile', 'legacy-runtime-defaults-upgraded', {
        profile,
        permissions: runtimeUpgrade.permissions,
        codex: runtimeUpgrade.codex,
        workspace: defaultWorkspaceUpgrade.changed,
      });
    }
    assertBootstrapAppMatchesExistingProfile(opts, profile, profileConfig);
    const cfg = await maybeMigrateRootPlaintextSecret(rootConfig, profile, appPaths, configPath);
    return { cfg, profileConfig, configPath, appPaths, profile };
  }

  const existing = await loadConfig(configPath);
  if (isComplete(existing)) {
    assertBootstrapAppMatchesExistingConfig(opts, profile, existing);
    const cfg = await maybeMigratePlaintextSecret(existing, configPath, appPaths);
    const profileConfig = createRuntimeProfileConfig({
      agentKind: requestedAgent ?? 'claude',
      accounts: cfg.accounts,
      preferences: cfg.preferences,
      secrets: cfg.secrets,
    });
    profileConfig.workspaces.default = await resolveConvertedLegacyDefaultWorkspace(opts, appPaths);
    const root = createRootConfig(profile, profileConfig, cfg.secrets);
    await saveRootConfig(root, configPath);
    await writeActiveProfile(appPaths.rootDir, profile);
    return { cfg: runtimeProfileConfig(root, profile), profileConfig, configPath, appPaths, profile };
  }

  if (!opts.allowBootstrap) {
    throw new Error('config not initialized');
  }
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const root = createRootConfig(profile, profileConfig, encrypted.secrets);
  await saveRootConfig(root, configPath);
  await writeActiveProfile(appPaths.rootDir, profile);
  console.log(`配置已保存到 ${configPath}\n`);
  return { cfg: runtimeProfileConfig(root, profile), profileConfig, configPath, appPaths, profile };
}

async function bootstrapProfileIntoExistingRoot(args: {
  rootConfig: RootConfig;
  profile: string;
  requestedAgent: AgentKind | undefined;
  opts: ResolveProfileRuntimeOptions;
  appPaths: AppPaths;
  configPath: string;
}): Promise<ProfileRuntime> {
  const { rootConfig, profile, requestedAgent, opts, appPaths, configPath } = args;
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const nextRoot: RootConfig = {
    ...rootConfig,
    ...(rootConfig.secrets ?? encrypted.secrets
      ? { secrets: rootConfig.secrets ?? encrypted.secrets }
      : {}),
    profiles: {
      ...rootConfig.profiles,
      [profile]: {
        ...profileConfig,
        secrets: undefined,
      },
    },
  };
  await saveRootConfig(markPermissionDefaultsMigration(nextRoot, profile), configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(nextRoot, profile),
    profileConfig,
    configPath,
    appPaths,
    profile,
  };
}

function upgradeLegacyRuntimeDefaults(
  rootConfig: RootConfig,
  profile: string,
): { rootConfig: RootConfig; changed: boolean; permissions: boolean; codex: boolean } {
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig) {
    return { rootConfig, changed: false, permissions: false, codex: false };
  }

  const permissionDefaultsMigrated = hasPermissionDefaultsMigration(rootConfig, profile);
  const shouldUpgradeClaudeDefaultPermissions =
    !permissionDefaultsMigrated &&
    profileConfig.agentKind === 'claude' &&
    !profileConfig.permissions.claude?.permissionMode &&
    profileConfig.permissions.defaultAccess === 'workspace' &&
    profileConfig.permissions.maxAccess === 'workspace';
  const legacySandboxPolicy = profileConfig.permissionSource === 'sandbox';
  const nextPermissions = shouldUpgradeClaudeDefaultPermissions
    ? { defaultAccess: 'full' as const, maxAccess: 'full' as const }
    : profileConfig.permissions;
  const legacyCodexDefaults = profileConfig.permissionSource !== 'permissions';
  const legacyIsolatedCodexHome =
    legacyCodexDefaults &&
    profileConfig.agentKind === 'codex' &&
    Boolean(profileConfig.codex) &&
    !profileConfig.codex?.codexHome &&
    profileConfig.codex?.inheritCodexHome === false;
  const legacyIgnoredUserConfig =
    legacyCodexDefaults &&
    profileConfig.agentKind === 'codex' &&
    Boolean(profileConfig.codex) &&
    !profileConfig.codex?.codexHome &&
    profileConfig.codex?.ignoreUserConfig === true;
  const permissionsChanged = legacySandboxPolicy || shouldUpgradeClaudeDefaultPermissions;
  const permissionDefaultsMarkerChanged = !permissionDefaultsMigrated;
  const codexChanged = legacyIsolatedCodexHome || legacyIgnoredUserConfig;
  if (!permissionsChanged && !codexChanged && !permissionDefaultsMarkerChanged) {
    return { rootConfig, changed: false, permissions: false, codex: false };
  }

  const nextProfile: ProfileConfig = {
    ...profileConfig,
    ...(permissionsChanged
      ? {
          permissions: nextPermissions,
          permissionSource: 'permissions' as const,
          sandbox: permissionsToLegacySandbox(nextPermissions),
        }
      : {}),
    ...(profileConfig.codex
      ? {
          codex: {
            ...profileConfig.codex,
            ...(legacyIsolatedCodexHome ? { inheritCodexHome: true } : {}),
            ...(legacyIgnoredUserConfig ? { ignoreUserConfig: false } : {}),
          },
        }
      : {}),
  };

  const nextRoot = {
    ...rootConfig,
    profiles: {
      ...rootConfig.profiles,
      [profile]: nextProfile,
    },
  };

  return {
    changed: true,
    permissions: permissionsChanged,
    codex: codexChanged,
    rootConfig: permissionDefaultsMarkerChanged
      ? markPermissionDefaultsMigration(nextRoot, profile)
      : nextRoot,
  };
}

async function ensureProfileDefaultWorkspace(
  rootConfig: RootConfig,
  profile: string,
  appPaths: AppPaths,
): Promise<{ rootConfig: RootConfig; changed: boolean }> {
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig || profileConfig.workspaces.default) {
    return { rootConfig, changed: false };
  }

  await mkdir(appPaths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const defaultWorkspace = await realpath(appPaths.defaultWorkspaceDir);
  const nextProfile: ProfileConfig = {
    ...profileConfig,
    workspaces: {
      ...profileConfig.workspaces,
      default: defaultWorkspace,
    },
  };

  return {
    changed: true,
    rootConfig: {
      ...rootConfig,
      profiles: {
        ...rootConfig.profiles,
        [profile]: nextProfile,
      },
    },
  };
}

async function resolveConvertedLegacyDefaultWorkspace(
  opts: ResolveProfileRuntimeOptions,
  appPaths: AppPaths,
): Promise<string> {
  if (opts.workspace) return resolveBootstrapWorkspace(opts.workspace);
  const legacyDefault = await collectLegacyDefaultWorkspace(appPaths.rootDir);
  if (legacyDefault) return legacyDefault;
  await mkdir(appPaths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  return realpath(appPaths.defaultWorkspaceDir);
}

// Unlike migrate.ts's legacy profile-name heuristic (which guesses agentKind
// for pre-existing v1 configs and deliberately has no 'pi' case, since pi has
// no legacy installations to guess about), `profile` here is often the value
// this same bootstrap flow just set moments earlier from agent
// auto-detection/wizard selection — so decoding 'pi' back out of it is not a
// guess, it's required for a freshly-selected pi profile to bootstrap as pi
// instead of silently falling back to claude.
function resolveBootstrapAgent(
  requestedAgent: AgentKind | undefined,
  profile: string | undefined,
): AgentKind | undefined {
  if (requestedAgent) return requestedAgent;
  if (profile === 'codex' || profile === 'pi') return profile;
  return undefined;
}

async function hasLegacyConfig(configPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
  return parsed.schemaVersion !== 2;
}

async function migrateV1ToV2WithActiveBridgeHandling(
  options: MigrateV2Options,
  handler: ResolveProfileRuntimeOptions['handleActiveBridgeMigrationConflict'],
): Promise<void> {
  for (;;) {
    try {
      await migrateV1ToV2(options);
      return;
    } catch (err) {
      if (!(err instanceof ActiveBridgeMigrationConflictError) || !handler) throw err;
      const shouldRetry = await handler(err);
      if (!shouldRetry) throw err;
    }
  }
}

async function resolveBootstrapAppConfig(opts: ResolveProfileRuntimeOptions): Promise<AppConfig> {
  if (!opts.appId) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        '当前没有配置，非交互模式无法完成扫码创建应用。' +
          '请先在终端运行 `lark-channel-bridge run` 完成首次初始化，' +
          '或传入 --app-id 和 --app-secret。',
      );
    }
    return runRegistrationWizard();
  }
  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        `非交互模式缺少 App Secret: ${opts.appId}。` +
          '请传入 --app-secret <secret>，或在终端中重新运行命令后按提示输入。',
      );
    }
    appSecret = await promptPassword(`输入 ${opts.appId} 的 App Secret: `);
  }
  if (!appSecret) throw new Error('app secret is required');
  const tenant = tenantBrandFromString(opts.tenant);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant);
  if (!result.ok) {
    throw new Error(`app credentials validation failed: ${result.reason ?? 'unknown'}`);
  }
  if (result.botName) {
    console.log(`✓ 应用凭证校验通过: ${result.botName}`);
  } else {
    console.log('✓ 应用凭证校验通过');
  }
  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant,
      },
    },
  };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function tenantBrandFromString(value: string | undefined): TenantBrand {
  if (value === undefined) return 'feishu';
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`unsupported tenant: ${value}`);
}

function assertBootstrapAppMatchesExistingProfile(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  profileConfig: ProfileConfig,
): void {
  if (!opts.appId || opts.appId === profileConfig.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${profileConfig.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

function assertRequestedAgentMatchesExistingProfile(
  profile: string,
  profileConfig: ProfileConfig,
  requestedAgent: AgentKind | undefined,
): void {
  if (!requestedAgent || profileConfig.agentKind === requestedAgent) return;
  throw new Error(
    `profile ${profile} already exists with agentKind ${profileConfig.agentKind}, ` +
      `but this command requested --agent ${requestedAgent}. ` +
      `Profile names are labels; to use the existing ${profileConfig.agentKind} profile, omit --agent. ` +
      `To recreate it as ${requestedAgent}, remove profile ${profile} first.`,
  );
}

function assertBootstrapAppMatchesExistingConfig(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  cfg: AppConfig,
): void {
  if (!opts.appId || opts.appId === cfg.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${cfg.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

export async function materializeEnvSecretForService(
  opts: MaterializeEnvSecretForServiceOptions = {},
): Promise<boolean> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) throw new Error(`profile not found: ${profile}`);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    if (!isEnvBackedSecret(cfg.accounts.app.secret)) return false;

    const encrypted = await encryptedConfigForResolvedSecret(
      cfg,
      await resolveAppSecret(cfg, appPaths),
      appPaths,
    );
    rootConfig.profiles[profile] = {
      ...profileConfig,
      accounts: encrypted.accounts,
    };
    if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
    await saveRootConfig(rootConfig, configPath);
    return true;
  }

  const existing = await loadConfig(configPath);
  if (!isComplete(existing) || !isEnvBackedSecret(existing.accounts.app.secret)) return false;
  const encrypted = await encryptedConfigForResolvedSecret(
    existing,
    await resolveAppSecret(existing, appPaths),
    appPaths,
  );
  await saveConfig(encrypted, configPath);
  return true;
}

function formatAmbiguousAgentSelectionError(
  detected: Array<{ kind: AgentKind; binaryPath: string }>,
): string {
  const lines = detected.map((agent) => `  - ${agent.kind}: ${agent.binaryPath}`);
  return [
    '检测到多个本地 agent，请使用 --agent <claude|codex|pi> 指定要初始化哪一个。',
    '已检测到：',
    ...lines,
  ].join('\n');
}

async function selectDetectedAgent(
  detected: DetectedAgent[],
  selector: ResolveProfileRuntimeOptions['selectAgent'],
): Promise<AgentKind | undefined> {
  const selected = selector
    ? await selector(detected)
    : await promptForDetectedAgentSelection(detected);
  if (!selected) return undefined;
  return detected.some((agent) => agent.kind === selected) ? selected : undefined;
}

async function promptForDetectedAgentSelection(detected: DetectedAgent[]): Promise<AgentKind | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  p.intro('选择本地 agent');
  const selected = await p.select<AgentKind>({
    message: '检测到多个本地 agent，本次要初始化哪一个？',
    options: detected.map((agent) => ({
      value: agent.kind,
      label: displayAgentKind(agent.kind),
      hint: agent.binaryPath,
    })),
    initialValue: detected[0]?.kind,
  });
  if (p.isCancel(selected)) {
    p.cancel('已取消 agent 选择。');
    throw new UserCancelledError('已取消启动。');
  }
  p.outro(`已选择 ${displayAgentKind(selected)}`);
  return selected;
}

class UserCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserCancelledError';
  }
}

function displayAgentKind(kind: AgentKind): string {
  if (kind === 'codex') return 'Codex CLI';
  if (kind === 'pi') return 'Pi';
  return 'Claude Code';
}

async function maybeMigrateRootPlaintextSecret(
  rootConfig: RootConfig,
  profile: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
  configPath: string,
): Promise<AppConfig & { agentKind?: AgentKind }> {
  const cfg = runtimeProfileConfig(rootConfig, profile);
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string' || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(secret)) {
    return cfg;
  }

  const encrypted = await encryptedConfigForProfile(cfg, appPaths);
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig) throw new Error(`profile not found: ${profile}`);
  rootConfig.profiles[profile] = {
    ...profileConfig,
    accounts: encrypted.accounts,
  };
  if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
  await saveRootConfig(rootConfig, configPath);
  return runtimeProfileConfig(rootConfig, profile);
}

async function encryptedConfigForProfile(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string') return cfg;
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), secret, appPaths);
  return next;
}

async function encryptedConfigForResolvedSecret(
  cfg: AppConfig,
  plaintext: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), plaintext, appPaths);
  return next;
}

function isEnvBackedSecret(secret: SecretInput): boolean {
  if (typeof secret === 'string') return ENV_SECRET_TEMPLATE_RE.test(secret);
  return isSecretRef(secret) && secret.source === 'env';
}

async function maybeMigratePlaintextSecret(
  cfg: AppConfig,
  configPath: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;
  if (typeof s === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths,
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s, appPaths);
      await saveConfig(next, configPath);
      console.log('🔒 已把 App Secret 加密迁移到 ~/.lark-channel/secrets.enc');
      return next;
    } catch (err) {
      log.warn('config', 'migrate-encrypted-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return cfg;
    }
  }

  if (typeof s === 'string') return cfg;

  try {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths);
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths,
      );
      await saveConfig(next, configPath);
      console.log('🔒 已把 secrets provider 切到 wrapper 形态');
      return next;
    }
  } catch (err) {
    log.warn('config', 'wrapper-refresh-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cfg;
}

function needsProviderRewrite(cfg: AppConfig, wrapperPath: string): boolean {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}
