import type { AgentKind } from '../config/profile-schema';
import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/**
 * OpenCode static model list. OpenCode supports many providers and its model
 * set changes over time, so the picker is populated dynamically via
 * `fetchOpencodeModels`. This static list returns only DEFAULT_MODEL so that
 * `normalizeModelSelection`'s allowlist check does not reject stored values
 * (opencode values are free-form `provider/model` strings, validated separately).
 */
const OPENCODE_MODELS: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  if (agentKind === 'codex') return CODEX_MODELS;
  if (agentKind === 'opencode') return OPENCODE_MODELS;
  return CLAUDE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 *
 * For opencode, non-default values are accepted as free-form `provider/model`
 * strings (validated only that they are non-empty), since opencode's model
 * set is provider-dependent and not a fixed allowlist.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  if (agentKind === 'opencode') return value as string; // free-form provider/model
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/**
 * Picker label for a stored value, for display in the saved-config card.
 * When `extraOptions` is provided (dynamically-fetched opencode models),
 * searches those first before falling back to the static catalog.
 */
export function modelLabel(
  agentKind: AgentKind,
  value: string | undefined,
  extraOptions?: ModelOption[],
): string {
  const normalized = normalizeModelSelection(agentKind, value);
  if (extraOptions) {
    const found = extraOptions.find((m) => m.value === normalized);
    if (found) return found.label;
  }
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}

/**
 * Validate a raw form-submitted model value. For claude/codex the value must
 * be in the static allowlist; for opencode any non-empty non-default string is
 * accepted (models are free-form `provider/model` tokens).
 */
export function isValidModelSelection(agentKind: AgentKind, rawValue: string): boolean {
  if (rawValue === '') return false;
  if (rawValue === DEFAULT_MODEL) return true;
  if (agentKind === 'opencode') return true; // free-form provider/model
  return supportedModels(agentKind).some((m) => m.value === rawValue);
}

/**
 * Fetch the models the installed opencode binary advertises via
 * `opencode models`. Used to populate the /config model picker dynamically
 * (opencode's model set is provider-dependent and changes over time, unlike
 * Claude/Codex's pinned lists). Returns [] on any failure — the picker
 * then falls back to DEFAULT_MODEL only.
 *
 * Each stdout token containing `/` is treated as a `provider/model` value.
 */
export async function fetchOpencodeModels(binaryPath: string): Promise<ModelOption[]> {
  try {
    const child = spawnProcess(binaryPath, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exitCode: number | null = await new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code));
    });
    if (exitCode !== 0) {
      log.warn('models', 'opencode-models-nonzero', { exitCode, stderr: stderr.slice(0, 200) });
      return [];
    }
    const tokens = stdout.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const tok of tokens) {
      if (!tok.includes('/')) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      models.push({ value: tok, label: tok });
    }
    return models;
  } catch (err) {
    log.warn('models', 'opencode-models-failed', { message: (err as Error).message });
    return [];
  }
}
