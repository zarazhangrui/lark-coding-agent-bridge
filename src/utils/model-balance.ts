import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { getSecret, setSecret } from '../config/keystore';
import { log } from '../core/logger';

// ========================================================================
// Types
// ========================================================================

export interface ResolvedProvider {
    apiKey: string;
    providerName: string;
    baseUrl: string;
}

// ========================================================================
// Keystore key helper — entry IDs use profile name as prefix so that
// multiple profiles coexist in the same secrets.enc.
// Examples: `claude:OPENAI_API_KEY`, `codex:OPENAI_BASE_URL`
// ========================================================================

function ksKey(keyName: string, profile: string): string {
    return `${profile}:${keyName}`;
}

// ========================================================================
// Provider declarations — balance fetch only (key resolution is now
// entirely driven by the per-profile import sources below).
// ========================================================================

/** balanceFetchers[providerName] → fetches account balance from the provider API */
const balanceFetchers: Record<string, (apiKey: string, baseUrl: string) => Promise<string | undefined>> = {
    DeepSeek: fetchDeepseekBalance,
    Kimi: fetchKimiBalance,
};

/**
 * profileImportSources[profileName] → declares how to auto-import model
 * keys for each supported agent platform.
 *
 * Profile  Import logic
 * -------  ------------------------------------------------------------------
 * claude   Read `~/.claude/settings.json` env section — Claude stores its
 *          full env config (including API keys) in this JSON file.
 *
 * codex    Codex CLI does **not** store actual API keys in any config file.
 *          Its `~/.codex/config.toml` maps provider IDs to env var names
 *          via `env_key` (e.g. `env_key = "OPENAI_API_KEY"`). The actual
 *          key value only exists in the codex process's environment at
 *          runtime, which is invisible to lark-bridge (a separate daemon).
 *
 *          What we CAN extract from `config.toml`:
 *            - active model_provider (e.g. "deepseek")
 *            - base_url for that provider
 *            - env_key (the env var name, e.g. "OPENAI_API_KEY")
 *
 *          What we CANNOT extract:
 *            - the actual API key value
 *
 *          The import writes `base_url` to keystore. For the API key, it
 *          tries `process.env[envKey]` (best-effort — works if daemon is
 *          started from a session where the env var happens to be set).
 *          If the key is unavailable, the import silently skips it; the
 *          user can set it manually via `lark-channel-bridge secrets set`.
 */
const profileImportSources: Record<string, (profile: string) => Promise<boolean>> = {
    claude: importFromClaudeSettings,
    codex: importFromCodexConfig,
};

// ========================================================================
// Resolution logic
// ========================================================================

/**
 * Resolve the model provider info — checks, in order:
 *  1. Per-profile encrypted keystore (entries `<profile>:OPENAI_API_KEY` etc.)
 *  2. Auto-import from agent config, then retry keystore
 *
 * Note: `process.env` is deliberately NOT checked here. lark-bridge runs
 * as a standalone daemon (or foreground process), not as a child of the
 * agent CLI. The agent's environment variables belong to the agent process
 * and are never inherited by the bridge.
 */
export async function resolveModelProvider(profile?: string): Promise<ResolvedProvider | null> {
    if (!profile) return null;

    // 1. Try per-profile encrypted keystore
    const storeProvider = await resolveFromKeystore(profile);
    if (storeProvider) {
        return storeProvider;
    }

    // 2. Auto-import from the agent's native config, then retry
    const importFn = profileImportSources[profile];
    if (importFn) {
        try {
            const ok = await importFn(profile);
            if (ok) {
                const retry = await resolveFromKeystore(profile);
                if (retry) {
                    return retry;
                }
            }
        } catch (err) {
        }
    }

    return null;
}

/**
 * Fetch the account balance from the model provider.
 * Routes to the right fetcher via `balanceFetchers[provider.providerName]`.
 */
export async function fetchModelBalance(provider: ResolvedProvider): Promise<string | undefined> {
    const fetcher = balanceFetchers[provider.providerName];
    return fetcher ? fetcher(provider.apiKey, provider.baseUrl) : undefined;
}

// ---- keystore helpers ----

function storePathsFor(profile: string) {
    const p = resolveAppPaths({ profile });
    return { secretsFile: p.secretsFile, keystoreSaltFile: p.keystoreSaltFile };
}

async function resolveFromKeystore(profile: string): Promise<ResolvedProvider | null> {
    try {
        const sp = storePathsFor(profile);
        const openaiKey = await getSecret(ksKey('OPENAI_API_KEY', profile), sp);
        const baseUrl = await getSecret(ksKey('OPENAI_BASE_URL', profile), sp);

        if (openaiKey && baseUrl?.includes('deepseek.com')) {
            return { apiKey: openaiKey, providerName: 'DeepSeek', baseUrl };
        }

        const moonshotKey = await getSecret(ksKey('MOONSHOT_API_KEY', profile), sp);
        if (moonshotKey) {
            return { apiKey: moonshotKey, providerName: 'Kimi', baseUrl: 'https://api.moonshot.cn' };
        }

        return null;
    } catch (err) {
        return null;
    }
}

// ========================================================================
// Profile import implementations
// ========================================================================

/**
 * Import from Claude Code's `~/.claude/settings.json`.
 *
 * This file has an `env` section containing the full env config
 * (API keys, base URLs, model preferences).
 */
async function importFromClaudeSettings(profile: string): Promise<boolean> {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let raw: string;
    try {
        raw = await readFile(settingsPath, 'utf8');
    } catch {
        return false;
    }

    let parsed: { env?: Record<string, string> };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }

    const env = parsed?.env;
    if (!env || typeof env !== 'object') {
        return false;
    }

    const relevantKeys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MOONSHOT_API_KEY'];
    const sp = storePathsFor(profile);
    let count = 0;

    for (const key of relevantKeys) {
        const val = env[key];
        if (val && typeof val === 'string') {
            await setSecret(ksKey(key, profile), val, sp);
            count++;
        }
    }

    if (count > 0) {
        log.info('model-balance', 'imported-claude-keys', { profile, count });
        return true;
    }
    return false;
}

/**
 * Import from Codex CLI's `~/.codex/config.toml`.
 *
 * Codex stores provider config (base_url, env_key reference) in TOML
 * format. The actual API key is NOT in this file — it comes from the
 * environment variable named by `env_key`. We extract what we can:
 *
 *  - `base_url` is written directly to the keystore
 *  - API key is read from `process.env[envKey]` if available (best-effort)
 *
 * Returns true if at least `base_url` was successfully imported.
 */
async function importFromCodexConfig(profile: string): Promise<boolean> {
    const configPath = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(configPath)) {
        return false;
    }

    let raw: string;
    try {
        raw = await readFile(configPath, 'utf8');
    } catch {
        return false;
    }

    // Parse the active model_provider name (e.g. `model_provider = "deepseek"`)
    const modelProvider = raw.match(/^model_provider\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!modelProvider) {
        return false;
    }

    // Find the matching [model_providers.<name>] section and extract its content
    const sectionRe = new RegExp(`\\[model_providers\\.${escapeRegex(modelProvider)}\\]\\s*\\n([^\\[]*)`);
    const sectionMatch = raw.match(sectionRe);
    if (!sectionMatch || !sectionMatch[1]) {
        return false;
    }
    const sectionBody = sectionMatch[1];

    const baseUrl = sectionBody.match(/^base_url\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const envKey = sectionBody.match(/^env_key\s*=\s*"([^"]+)"\s*$/m)?.[1];

    if (!baseUrl) {
        return false;
    }

    const sp = storePathsFor(profile);

    // Store base_url — always available from config.toml
    await setSecret(ksKey('OPENAI_BASE_URL', profile), baseUrl, sp);

    // Store API key — only available if the env var happens to be set in our
    // process (e.g. when the daemon is started from a login shell that exports it)
    if (envKey) {
        const keyValue = process.env[envKey];
        if (keyValue) {
            await setSecret(ksKey('OPENAI_API_KEY', profile), keyValue, sp);
            log.info('model-balance', 'imported-codex-key', { profile, envKey });
        }
    }

    return true;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========================================================================
// Provider-specific balance fetch implementations
// ========================================================================

async function fetchDeepseekBalance(apiKey: string, baseUrl: string): Promise<string | undefined> {
    try {
        const url = `${baseUrl.replace(/\/+$/, '')}/user/balance`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
            log.warn('model-balance', 'deepseek-fetch-failed', { status: res.status });
            return undefined;
        }
        const body = (await res.json()) as {
            is_available?: boolean;
            balance_infos?: Array<{
                currency?: string;
                total_balance?: string;
                granted_balance?: string;
                topped_up_balance?: string;
            }>;
        };
        if (!body.balance_infos || body.balance_infos.length === 0) {
            return body.is_available === false ? '不可用' : undefined;
        }
        return body.balance_infos
            .map((b) => {
                const cur = b.currency ?? 'CNY';
                const total = b.total_balance ?? '?';
                return `${cur} ${total}`;
            })
            .join(' / ');
    } catch (err) {
        log.warn('model-balance', 'deepseek-error', {
            message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

async function fetchKimiBalance(apiKey: string, _baseUrl: string): Promise<string | undefined> {
    try {
        const res = await fetch('https://api.moonshot.cn/v1/users/me/balance', {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
            log.warn('model-balance', 'kimi-fetch-failed', { status: res.status });
            return undefined;
        }
        const body = (await res.json()) as {
            status?: boolean;
            data?: {
                available_balance?: number;
                voucher_balance?: number;
                cash_balance?: number;
            };
        };
        if (body.data?.available_balance !== undefined) {
            return `¥${body.data.available_balance.toFixed(2)}`;
        }
        return undefined;
    } catch (err) {
        log.warn('model-balance', 'kimi-error', {
            message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}
