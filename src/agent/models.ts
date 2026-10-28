import type { AgentKind } from '../config/profile-schema';

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
 * OMP models are user-configurable (providers + `omp models` catalog), so the
 * picker only offers "use OMP's configured default". A concrete
 * `provider/model` value can still be stored in `preferences.model`; it is
 * forwarded verbatim and surfaced as an extra picker option by
 * {@link modelOptions}.
 */
const OMP_MODELS: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随 OMP 默认（不指定）' }];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  switch (agentKind) {
    case 'codex':
      return CODEX_MODELS;
    case 'omp':
      return OMP_MODELS;
    default:
      return CLAUDE_MODELS;
  }
}

/**
 * Picker options for a profile, including a stored OMP model that is not in
 * the static catalog. Feishu rejects an `initial_option` that is absent from
 * the option list, so a custom value must be appended before rendering.
 */
export function modelOptions(agentKind: AgentKind, current?: string): ModelOption[] {
  const options = supportedModels(agentKind);
  const value = current?.trim();
  if (!value || value === DEFAULT_MODEL || options.some((option) => option.value === value)) {
    return options;
  }
  return [...options, { value, label: value }];
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
 * OMP is the exception: its catalog is user-managed, so any non-empty value
 * is kept and forwarded as `--model`.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_MODEL;
  if (agentKind === 'omp') return trimmed;
  return supportedModels(agentKind).some((m) => m.value === trimmed)
    ? trimmed
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

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return (
    supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized
  );
}
