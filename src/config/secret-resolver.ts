import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSecret } from './keystore';
import { paths } from './paths';
import type { AppConfig, ProviderConfig, SecretInput, SecretRef } from './schema';
import { isSecretRef, secretKeyForApp } from './schema';

/**
 * Bridge runtime secret resolver. Mirrors the openclaw / lark-cli
 * `ResolveSecretInput` contract so users can keep their App Secret out of
 * `config.json` via:
 *
 *   - plain string                              → as-is
 *   - "${VAR_NAME}" template                    → process.env[VAR_NAME]
 *   - { source: "env", id: "VAR", ... }         → process.env[VAR] (+ allowlist)
 *   - { source: "file", id: "/path", ... }      → contents of file
 *   - { source: "exec", id, provider, ... }     → spawn provider command, JSON RPC
 *
 * The exec branch short-circuits when the provider command points at this
 * same bridge binary — we then read the AES keystore directly instead of
 * spawning ourselves (avoids fork bombs on misconfig, and keeps `bridge
 * start` working without `lark-channel-bridge` on $PATH).
 */

const ENV_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;

const DEFAULT_PROVIDER = 'default';

const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT = 64 * 1024;

export async function resolveAppSecret(cfg: AppConfig): Promise<string> {
  const appId = cfg.accounts.app.id;
  const secret = cfg.accounts.app.secret;
  return resolveSecretInput(secret, cfg.secrets, appId);
}

async function resolveSecretInput(
  input: SecretInput,
  secretsCfg: AppConfig['secrets'],
  appId: string,
): Promise<string> {
  if (!input) {
    throw new Error('app secret is missing');
  }
  if (typeof input === 'string') {
    return resolvePlainOrTemplate(input);
  }
  if (!isSecretRef(input)) {
    throw new Error(`unsupported secret form: ${JSON.stringify(input)}`);
  }
  switch (input.source) {
    case 'env':
      return resolveEnvRef(input, lookupProvider(secretsCfg, input));
    case 'file':
      return resolveFileRef(input, lookupProvider(secretsCfg, input));
    case 'exec':
      return resolveExecRef(input, lookupProvider(secretsCfg, input), appId);
    default:
      throw new Error(`unknown secret source: ${(input as { source?: string }).source}`);
  }
}

function resolvePlainOrTemplate(value: string): string {
  if (!value) throw new Error('app secret is empty');
  const m = ENV_TEMPLATE_RE.exec(value);
  if (m) {
    const name = m[1] as string;
    const v = process.env[name];
    if (!v) throw new Error(`env var ${name} referenced by secret is not set`);
    return v;
  }
  return value;
}

function lookupProvider(
  secretsCfg: AppConfig['secrets'],
  ref: SecretRef,
): ProviderConfig | undefined {
  if (!secretsCfg?.providers) return undefined;
  const name = ref.provider ?? secretsCfg.defaults?.[ref.source] ?? DEFAULT_PROVIDER;
  return secretsCfg.providers[name];
}

function resolveEnvRef(ref: SecretRef, pc: ProviderConfig | undefined): string {
  if (pc?.allowlist && pc.allowlist.length > 0 && !pc.allowlist.includes(ref.id)) {
    throw new Error(`env var ${ref.id} is not allowlisted in provider`);
  }
  const v = process.env[ref.id];
  if (!v) throw new Error(`env var ${ref.id} is not set`);
  return v;
}

async function resolveFileRef(ref: SecretRef, pc: ProviderConfig | undefined): Promise<string> {
  // ref.id is the path; if provider.path is set, treat ref.id as relative to it.
  const path = pc?.path ? join(pc.path, ref.id) : ref.id;
  const text = await readFile(path, 'utf8');
  return text.trim();
}

/**
 * Spawn the configured provider command, send the JSON-RPC request on
 * stdin, parse the JSON-RPC response from stdout, return the secret for
 * `ref.id`. Implements the same protocol openclaw / lark-cli's
 * `resolveExecRef` uses, so users can write a script once and point either
 * tool at it.
 *
 * If the configured command IS this same bridge binary (a.k.a. bridge is
 * self-hosting via `lark-channel-bridge secrets get`), short-circuit and
 * read the AES keystore directly. Keeps `bridge start` working even when
 * the bridge symlink isn't on $PATH, and avoids spawning ourselves on
 * every reconnect.
 */
async function resolveExecRef(
  ref: SecretRef,
  pc: ProviderConfig | undefined,
  appId: string,
): Promise<string> {
  if (!pc?.command) {
    throw new Error('exec provider missing `command`');
  }

  if (isSelfBridgeCommand(pc.command, pc.args)) {
    // Short-circuit: read keystore directly. The expected id under the
    // bridge convention is `app-<appId>`; if the user wired something
    // else, fall back to ref.id verbatim.
    const candidate = await getSecret(ref.id);
    if (candidate !== undefined) return candidate;
    const conventional = secretKeyForApp(appId);
    const fallback = await getSecret(conventional);
    if (fallback !== undefined) return fallback;
    throw new Error(`keystore has no entry for "${ref.id}" or "${conventional}"`);
  }

  return spawnExecProvider(pc, ref);
}

function isSelfBridgeCommand(command: string, args: string[] | undefined): boolean {
  const commandMatches = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const legacyWrapperPath =
    process.platform === 'win32' && paths.secretsGetterScript.toLowerCase().endsWith('.cmd')
      ? paths.secretsGetterScript.slice(0, -4)
      : '';
  // Canonical form (post-wrapper): command is our own secrets-getter
  // script and args is empty. Match path exactly.
  if (commandMatches(command, paths.secretsGetterScript)) return true;
  if (legacyWrapperPath && commandMatches(command, legacyWrapperPath)) return true;
  // Legacy / hand-edited form: command is node and args end with
  // ['secrets', 'get']. Keep this branch so configs written by older
  // bridge versions, or by power-users editing config.json directly,
  // still short-circuit and avoid a re-spawn.
  if (args && args.length >= 2) {
    const a = args[args.length - 2];
    const b = args[args.length - 1];
    if (a === 'secrets' && b === 'get') return true;
  }
  return false;
}

async function spawnExecProvider(pc: ProviderConfig, ref: SecretRef): Promise<string> {
  const timeoutMs = pc.noOutputTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutput = pc.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT;
  const providerName = ref.provider ?? DEFAULT_PROVIDER;

  return new Promise<string>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    if (pc.passEnv) {
      for (const k of pc.passEnv) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    }
    if (pc.env) Object.assign(env, pc.env);

    const child = spawnProviderCommand(pc.command!, pc.args ?? [], env);

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`exec provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (stdout.length + chunk.length > maxOutput) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`exec provider failed to start: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        reject(new Error(`exec provider stdout exceeded ${maxOutput} bytes`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : '';
        reject(new Error(`exec provider exited with code ${code}${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          values?: Record<string, string>;
          errors?: Record<string, { message?: string }>;
        };
        const value = parsed.values?.[ref.id];
        if (typeof value === 'string') {
          resolve(value);
          return;
        }
        const err = parsed.errors?.[ref.id]?.message;
        reject(new Error(`exec provider did not return secret for ${ref.id}${err ? `: ${err}` : ''}`));
      } catch (err) {
        reject(new Error(`exec provider returned invalid JSON: ${(err as Error).message}`));
      }
    });

    const request = JSON.stringify({
      protocolVersion: 1,
      provider: providerName,
      ids: [ref.id],
    });
    child.stdin.end(request);
  });
}

function spawnProviderCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const cmd = process.env.ComSpec ?? 'cmd.exe';
    const line = [command, ...args].map(quoteForCmd).join(' ');
    return spawn(cmd, ['/d', '/s', '/c', line], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  return spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
}

function quoteForCmd(value: string): string {
  if (!value) return '""';
  if (!/[\s"&()<>^|%]/.test(value)) return value;
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}
