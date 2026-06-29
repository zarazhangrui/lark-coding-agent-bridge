import { resolveAppPaths, type AppPaths } from '../../config/app-paths';
import { getSecret, listSecretIds, removeSecret, setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { secretKeyForApp } from '../../config/schema';
import { listAllProfiles } from '../../runtime/profile-discovery';
import { promptPassword } from '../prompt';

/**
 * `secrets` CLI surface. Two intended consumers:
 *
 * 1. Humans: `lark-channel-bridge secrets set/list/remove` to manage the
 *    encrypted keystore manually.
 *
 * 2. lark-cli (and any other tool implementing the exec-provider protocol):
 *    `lark-channel-bridge secrets get` reads a JSON-RPC request
 *    from stdin and writes the decrypted secret to stdout. This is what
 *    `accounts.app.secret = { source: "exec", ... }` resolves through when
 *    lark-cli binds against ~/.lark-channel/config.json.
 */

interface ExecRequest {
  protocolVersion?: number;
  provider?: string;
  ids?: string[];
}

interface ExecResponseValue {
  protocolVersion: number;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
}

const PROTOCOL_VERSION = 1;

interface SecretProfileOptions {
  profile?: string;
  rootDir?: string;
}

/**
 * `secrets get` — exec-provider protocol mode.
 *
 * Reads a JSON object from stdin:
 *   { "protocolVersion": 1, "provider": "<name>", "ids": ["app-cli_xxx", ...] }
 *
 * Writes a JSON object to stdout:
 *   { "protocolVersion": 1, "values": { "app-cli_xxx": "..." } }
 *
 * Missing entries land in `errors` rather than `values` — caller decides.
 * Process exits 0 on a successful protocol exchange (even with per-id
 * errors). Non-zero exit means we couldn't parse stdin or the keystore
 * file itself is broken.
 */
export async function runSecretsGet(): Promise<void> {
  const input = await readAllStdin();
  let req: ExecRequest;
  try {
    req = JSON.parse(input || '{}') as ExecRequest;
  } catch (err) {
    console.error(`secrets get: invalid stdin JSON: ${(err as Error).message}`);
    process.exit(2);
  }
  const ids = req.ids ?? [];
  const resp: ExecResponseValue = {
    protocolVersion: PROTOCOL_VERSION,
    values: {},
  };
  for (const id of ids) {
    try {
      const v = await resolveSecretAcrossProfiles(id);
      if (v !== undefined) {
        resp.values[id] = v;
      } else {
        (resp.errors ??= {})[id] = { message: 'not found' };
      }
    } catch (err) {
      (resp.errors ??= {})[id] = { message: (err as Error).message };
    }
  }
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}

export async function runSecretsSet(
  appId: string | undefined,
  opts: SecretProfileOptions = {},
): Promise<void> {
  if (!appId) {
    console.error('用法: lark-channel-bridge secrets set --app-id <id>');
    process.exit(1);
  }
  const plaintext = await promptPassword(`输入 ${appId} 的 App Secret: `);
  if (!plaintext) {
    console.error('✗ 取消(secret 为空)');
    process.exit(1);
  }
  await setAppSecret(appId, plaintext, opts);
  console.log(`✓ 已加密存到 ~/.lark-channel/secrets.enc`);
}

export async function runSecretsList(opts: SecretProfileOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  const ids = await listSecretIds(appPaths);
  if (ids.length === 0) {
    console.log('当前没有加密存储的 secret。');
    return;
  }
  console.log(`# 当前共 ${ids.length} 个 secret 在加密存储里\n`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}

export async function runSecretsRemove(
  appId: string | undefined,
  opts: SecretProfileOptions = {},
): Promise<void> {
  if (!appId) {
    console.error('用法: lark-channel-bridge secrets remove --app-id <id>');
    process.exit(1);
  }
  const id = secretKeyForApp(appId);
  const removed = await removeAppSecret(appId, opts);
  if (!removed) {
    console.error(`✗ 没找到 secret: ${id}`);
    process.exit(1);
  }
  console.log(`✓ 已删除 ${id}`);
}

export async function resolveSecretAcrossProfiles(
  id: string,
  rootDir: string = paths.rootDir,
  warn: (message: string) => void = (message) => console.error(message),
  profile: string | undefined = process.env.LARK_CHANNEL_PROFILE,
): Promise<string | undefined> {
  if (profile) {
    const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
    if (!root || root.profiles[profile]) {
      const appPaths = resolveAppPaths({ rootDir, profile });
      const ids = await listSecretIds(appPaths);
      if (!ids.includes(id)) return undefined;
      return getSecret(id, appPaths);
    }
  }

  const profiles = await listSecretProfiles(rootDir);
  const matches: AppPaths[] = [];
  for (const profile of profiles) {
    const appPaths = resolveAppPaths({ rootDir, profile: profile.name });
    const ids = await listSecretIds(appPaths);
    if (ids.includes(id)) matches.push(appPaths);
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    warn(
      `secrets get: secret ${id} exists in multiple profiles; using ${matches[0]?.profile ?? 'unknown'}`,
    );
  }
  const first = matches[0];
  if (!first) return undefined;
  return getSecret(id, first);
}

export async function setAppSecret(
  appId: string,
  plaintext: string,
  opts: SecretProfileOptions = {},
): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  await setSecret(secretKeyForApp(appId), plaintext, appPaths);
}

export async function removeAppSecret(
  appId: string,
  opts: SecretProfileOptions = {},
): Promise<boolean> {
  const appPaths = await resolveSecretProfilePaths(opts);
  return removeSecret(secretKeyForApp(appId), appPaths);
}

async function resolveSecretProfilePaths(opts: SecretProfileOptions): Promise<AppPaths> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  const profile = opts.profile ?? (await readActiveProfile(rootDir)) ?? root?.activeProfile ?? 'claude';
  if (root && !root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return resolveAppPaths({ rootDir, profile });
}

async function listSecretProfiles(rootDir: string): Promise<Array<{ name: string }>> {
  try {
    return await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('root config not found:')) throw err;
    return [{ name: resolveAppPaths({ rootDir }).profile }];
  }
}

// ────────────────────────────────────────────────────────────

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''; // no input piped
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
