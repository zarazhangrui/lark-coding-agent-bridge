import { detectInstalledAgents } from '../cli/agent-detection';
import { resolveAppPaths } from '../config/app-paths';
import { setSecret } from '../config/keystore';
import {
  createRootConfig,
  loadRootConfig,
  readActiveProfile,
  saveRootConfig,
  withConfigFileLock,
  writeActiveProfile,
} from '../config/profile-store';
import type { AgentKind } from '../config/profile-schema';
import { secretKeyForApp, type AppConfig, type TenantBrand } from '../config/schema';
import { buildEncryptedAccountConfig } from '../config/store';
import { createBootstrapProfileConfig } from '../cli/profile-bootstrap';
import { validateAppCredentials } from '../utils/feishu-auth';
import { HttpError } from './http';

export interface OnboardState {
  hasConfig: boolean;
  activeProfile?: string;
  profiles: string[];
  detectedAgents: AgentKind[];
}

/** Snapshot for the wizard's first render: existing profiles + installed agents. */
export async function onboardState(rootDir?: string): Promise<OnboardState> {
  const appPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(appPaths.configFile);
  const detected = await detectInstalledAgents().catch(() => []);
  return {
    hasConfig: Boolean(root),
    activeProfile: await readActiveProfile(rootDir),
    profiles: root ? Object.keys(root.profiles) : [],
    detectedAgents: detected.map((d) => d.kind),
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

function readTenant(v: unknown): TenantBrand {
  return v === 'lark' ? 'lark' : 'feishu';
}

/** Validate app credentials (POST body: {appId, appSecret, tenant}). */
export async function onboardValidate(body: unknown) {
  const fv = asRecord(body);
  const appId = String(fv.appId ?? '').trim();
  const appSecret = String(fv.appSecret ?? '').trim();
  const tenant = readTenant(fv.tenant);
  if (!appId || !appSecret) throw new HttpError(400, 'appId 和 appSecret 必填');
  const result = await validateAppCredentials(appId, appSecret, tenant);
  if (!result.ok) throw new HttpError(400, `凭据校验失败：${result.reason ?? '未知原因'}`);
  return { ok: true, botName: result.botName, botOpenId: result.botOpenId };
}

export interface CreateProfileInput {
  profile: string;
  agentKind: AgentKind;
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
  workspace?: string;
}

/**
 * Create (or add) a profile from validated app credentials — the same sequence
 * the terminal bootstrap uses ({@link createBootstrapProfileConfig} +
 * {@link buildEncryptedAccountConfig} + keystore), so the web onboarding and
 * `run`/`start` produce identical on-disk config. The App Secret is stored only
 * in the encrypted keystore; config.json gets a SecretRef.
 */
export async function onboardCreate(body: unknown, rootDir?: string) {
  const fv = asRecord(body);
  const agentKind: AgentKind = fv.agentKind === 'codex' ? 'codex' : fv.agentKind === 'opencode' ? 'opencode' : 'claude';
  const input: CreateProfileInput = {
    profile: String(fv.profile ?? '').trim() || agentKind,
    agentKind,
    appId: String(fv.appId ?? '').trim(),
    appSecret: String(fv.appSecret ?? '').trim(),
    tenant: readTenant(fv.tenant),
    ...(typeof fv.workspace === 'string' && fv.workspace.trim() ? { workspace: fv.workspace.trim() } : {}),
  };
  if (!input.appId || !input.appSecret) throw new HttpError(400, 'appId 和 appSecret 必填');

  // Re-validate server-side so a client can't skip the check.
  const check = await validateAppCredentials(input.appId, input.appSecret, input.tenant);
  if (!check.ok) throw new HttpError(400, `凭据校验失败：${check.reason ?? '未知原因'}`);

  const { profile } = await writeNewProfile(input, rootDir);
  return { ok: true, profile, botName: check.botName };
}

/**
 * Persist a new profile from (already-valid) app credentials — the same
 * sequence the terminal bootstrap uses ({@link createBootstrapProfileConfig} +
 * {@link buildEncryptedAccountConfig} + keystore), so web onboarding, QR
 * creation, and `run`/`start` produce identical on-disk config. The App Secret
 * is stored only in the encrypted keystore; config.json gets a SecretRef.
 * Returns the canonical (normalized) profile name.
 */
export async function writeNewProfile(
  input: CreateProfileInput,
  rootDir?: string,
): Promise<{ profile: string }> {
  // resolveAppPaths normalizes the profile name; use the canonical form. A bad
  // name (path separators, whitespace, control chars) throws — surface it as a
  // 400 with the real reason instead of a generic 500 "internal error".
  let appPaths;
  try {
    appPaths = resolveAppPaths({ rootDir, profile: input.profile });
  } catch (err) {
    throw new HttpError(400, `profile 名称无效：${err instanceof Error ? err.message : String(err)}`);
  }
  const profile = appPaths.profile;

  // Never clobber an existing profile — this is a *new*-profile path. Fast-fail
  // before storing the secret; re-checked inside the lock against races.
  const pre = await loadRootConfig(appPaths.configFile);
  if (pre?.profiles[profile]) {
    throw new HttpError(409, `profile 已存在：${profile}，请换个名字`);
  }

  const encrypted = await encryptAccount(input, appPaths);

  let profileConfig;
  try {
    profileConfig = await createBootstrapProfileConfig({
      agentKind: input.agentKind,
      accounts: encrypted.accounts,
      preferences: encrypted.preferences,
      secrets: encrypted.secrets,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      defaultWorkspace: appPaths.defaultWorkspaceDir,
      profileDir: appPaths.profileDir,
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }

  await withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root) {
      await saveRootConfig(createRootConfig(profile, profileConfig, encrypted.secrets), appPaths.configFile);
      return;
    }
    if (root.profiles[profile]) {
      throw new HttpError(409, `profile 已存在：${profile}，请换个名字`);
    }
    root.profiles[profile] = { ...profileConfig, secrets: undefined };
    if (!root.secrets && encrypted.secrets) root.secrets = encrypted.secrets;
    await saveRootConfig(root, appPaths.configFile);
  });
  await writeActiveProfile(appPaths.rootDir, profile);

  return { profile };
}

async function encryptAccount(input: CreateProfileInput, appPaths: ReturnType<typeof resolveAppPaths>): Promise<AppConfig> {
  const next = await buildEncryptedAccountConfig(input.appId, input.tenant, undefined, appPaths);
  await setSecret(secretKeyForApp(input.appId), input.appSecret, appPaths);
  return next;
}
