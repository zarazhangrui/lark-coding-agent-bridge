export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Matches lark-cli's `SecretRef` shape so
 * `--source lark-channel` reads it through the same generic
 * `ResolveSecretInput` pipeline.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` declares how SecretRefs resolve to plaintext (env
 * allowlist, file path, exec command). Only the fields actually consumed by
 * bridge's resolver are typed here; lark-cli reads the same JSON via its
 * richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';
export type CotMessagesMode = 'off' | 'brief' | 'detailed';

/**
 * Access control settings. Empty lists are fail-closed in the v2 policy:
 * no DM senders, no group chats, and only the runtime owner can administer
 * the bot. Runtime owner/admin bypass is applied by the policy layer because
 * owner identity is refreshed from Lark rather than stored in config.json.
 */
export interface AppAccess {
  /** open_id allowlist for DM senders. Group senders are gated by chat. */
  allowedUsers?: string[];
  /** chat_id allowlist for groups the bot responds in. Does not apply to p2p. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws, /doc,
   * /invite, /remove). */
  admins?: string[];
  /** Per-chat @-mention override (chat_id → bool); overrides the global
   * requireMentionInGroup for the listed chats. */
  chatRequireMention?: Record<string, boolean>;
}

export interface AppPreferences {
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Default true. Turn off if you only care about Claude's final
   * text answer and want to hide the "工具调用过程".
   */
  showToolCalls?: boolean;
  /**
   * TOKEN-001: cap on incremental topic_context injection — max new messages
   * injected per run once a topic anchor exists. First engagement always
   * injects the full (40-message capped) history. Default 20.
   */
  topicContextMaxMessages?: number;
  /**
   * TOKEN-001: char cap on incremental topic_context injection. When the new
   * messages exceed it, older ones are folded into a pointer marker. Default
   * 8000. Values below 500 are treated as unset (silently fall back to the
   * default) to guard against typo-level configs effectively hiding context.
   */
  topicContextMaxChars?: number;
  /**
   * TOKEN-001 (measure 7): session-round soft alert. When a scope's run count
   * exceeds this threshold, a reminder to wrap up is injected into the next
   * prompt (re-fires every `sessionRoundAlertEvery` rounds). 0/undefined =
   * off. Advisory only.
   */
  sessionRoundAlertThreshold?: number;
  /**
   * TOKEN-001 (measure 7): reminder re-fire interval once over threshold.
   * Default 10.
   */
  sessionRoundAlertEvery?: number;
  /**
   * Model the underlying agent runs with, forwarded as `--model`. The catalog
   * of valid values is agent-kind specific — see `agent/models.ts`. `undefined`
   * or the `'default'` sentinel means "don't pass `--model`" so the agent
   * CLI / account default applies. Default: unset.
   */
  model?: string;
  /**
   * Whether to send a separate Lark COT process message before the final
   * answer. `brief` mirrors the lightweight tool/progress visibility from
   * the legacy tool display; `detailed` also includes tool args/output.
   * Legacy boolean/string `on` is accepted by the resolver for upgrades.
   */
  cotMessages?: CotMessagesMode | 'on' | 'simple';
  /**
   * Cap on concurrent claude runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for claude runs, in minutes. When set,
   * if claude emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach Claude (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the claude
   * subprocess. Bumped from a hardcoded 500ms because claude often has its
   * own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
}

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/** Resolve the show-tool-calls preference with default fallback. */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/** TOKEN-001: resolved caps for incremental topic_context injection. */
export function getTopicContextCaps(cfg: AppConfig): { maxMessages: number; maxChars: number } {
  const m = cfg.preferences?.topicContextMaxMessages;
  const c = cfg.preferences?.topicContextMaxChars;
  return {
    maxMessages: typeof m === 'number' && Number.isFinite(m) && m >= 1 ? Math.floor(m) : 20,
    maxChars: typeof c === 'number' && Number.isFinite(c) && c >= 500 ? Math.floor(c) : 8000,
  };
}

/** TOKEN-001 (measure 7): resolved session-round alert config. threshold 0 = off. */
export function getSessionRoundAlert(cfg: AppConfig): { threshold: number; every: number } {
  const t = cfg.preferences?.sessionRoundAlertThreshold;
  const e = cfg.preferences?.sessionRoundAlertEvery;
  return {
    threshold: typeof t === 'number' && Number.isFinite(t) && t >= 1 ? Math.floor(t) : 0,
    every: typeof e === 'number' && Number.isFinite(e) && e >= 1 ? Math.floor(e) : 10,
  };
}

export function getCotMessages(cfg: AppConfig): CotMessagesMode {
  const raw = cfg.preferences?.cotMessages;
  if (raw === 'brief' || raw === 'simple') return 'brief';
  if (raw === 'detailed' || raw === 'on') return 'detailed';
  return 'off';
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent claudes the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  if (cfg.preferences?.requireMentionInGroup !== undefined) {
    return cfg.preferences.requireMentionInGroup !== false;
  }
  const profileAccess = (cfg as AppConfig & {
    access?: { requireMentionInGroup?: boolean };
  }).access;
  if (profileAccess?.requireMentionInGroup !== undefined) {
    return profileAccess.requireMentionInGroup;
  }
  return true;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
/**
 * Grace period before SIGKILL fallback when stopping a claude subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}
