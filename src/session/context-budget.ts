import { readFile } from 'node:fs/promises';
import type { AutoNewSessionConfig } from '../config/schema';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export type ContextBudgetResetCode = 'input-tokens' | 'max-turns' | 'context-error';

export interface ContextBudgetResetReason {
  code: ContextBudgetResetCode;
  inputTokens?: number;
  threshold?: number;
  turns?: number;
  maxTurns?: number;
}

export interface ContextBudgetRunResult {
  terminal: 'done' | 'interrupted' | 'error' | 'idle_timeout';
  inputTokens?: number;
  errorMessage?: string;
}

export interface ContextBudgetEntry {
  turns: number;
  lastInputTokens?: number;
  maxInputTokens?: number;
  pendingResetReason?: ContextBudgetResetReason;
  updatedAt: number;
}

type ContextBudgetMap = Record<string, ContextBudgetEntry>;

const CONTEXT_LIMIT_RE =
  /(context[\s_-]*(?:length|window)|maximum[\s_-]*context|max(?:imum)?[\s_-]*tokens?|token[\s_-]*limit|too many tokens)/i;

export class ContextBudgetStore {
  private data: ContextBudgetMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        this.data = {};
        return;
      }
      this.data = {};
      for (const [scopeId, value] of Object.entries(raw)) {
        const entry = normalizeEntry(value);
        if (entry) this.data[scopeId] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('context-budget', err, { step: 'load' });
      this.data = {};
    }
  }

  pendingResetFor(scopeId: string, config: AutoNewSessionConfig): ContextBudgetResetReason | undefined {
    if (!config.enabled) return undefined;
    const entry = this.data[scopeId];
    if (!entry) return undefined;
    if (entry.pendingResetReason && resetReasonStillApplies(entry, entry.pendingResetReason, config)) {
      return { ...entry.pendingResetReason };
    }
    if (
      entry.maxInputTokens !== undefined &&
      inputTokenResetEligible(entry.turns, entry.maxInputTokens, config)
    ) {
      return {
        code: 'input-tokens',
        inputTokens: entry.maxInputTokens,
        threshold: config.inputTokenThreshold,
      };
    }
    if (config.maxTurns > 0 && entry.turns >= config.maxTurns) {
      return {
        code: 'max-turns',
        turns: entry.turns,
        maxTurns: config.maxTurns,
      };
    }
    return undefined;
  }

  recordRunResult(
    scopeId: string,
    result: ContextBudgetRunResult,
    config: AutoNewSessionConfig,
  ): ContextBudgetResetReason | undefined {
    if (!config.enabled) return undefined;
    const prev = this.data[scopeId] ?? { turns: 0, updatedAt: Date.now() };
    const contextError =
      result.terminal === 'error' && isContextLimitError(result.errorMessage);
    const turns = result.terminal === 'done' ? prev.turns + 1 : prev.turns;
    const lastInputTokens = result.inputTokens;
    const maxInputTokens =
      lastInputTokens === undefined
        ? prev.maxInputTokens
        : Math.max(prev.maxInputTokens ?? 0, lastInputTokens);

    let pendingResetReason: ContextBudgetResetReason | undefined;
    if (contextError) {
      pendingResetReason = { code: 'context-error' };
    } else if (
      lastInputTokens !== undefined &&
      inputTokenResetEligible(turns, lastInputTokens, config)
    ) {
      pendingResetReason = {
        code: 'input-tokens',
        inputTokens: lastInputTokens,
        threshold: config.inputTokenThreshold,
      };
    } else if (config.maxTurns > 0 && turns >= config.maxTurns) {
      pendingResetReason = {
        code: 'max-turns',
        turns,
        maxTurns: config.maxTurns,
      };
    }

    this.data[scopeId] = {
      turns,
      ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(pendingResetReason ? { pendingResetReason } : {}),
      updatedAt: Date.now(),
    };
    this.schedulePersist();
    return pendingResetReason ? { ...pendingResetReason } : undefined;
  }

  reset(scopeId: string): void {
    if (!this.data[scopeId]) return;
    delete this.data[scopeId];
    this.schedulePersist();
  }

  getRaw(scopeId: string): ContextBudgetEntry | undefined {
    const entry = this.data[scopeId];
    return entry ? { ...entry } : undefined;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    if (!this.path) return;
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path!, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('context-budget', err, { step: 'persist' });
      });
  }
}

export function isContextLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return CONTEXT_LIMIT_RE.test(message);
}

export function formatContextBudgetResetNotice(reason: ContextBudgetResetReason): string {
  switch (reason.code) {
    case 'input-tokens':
      return '上下文接近上限，已自动开启新会话。';
    case 'max-turns':
      return '当前会话轮数较多，已自动开启新会话。';
    case 'context-error':
      return '上一轮因上下文过大失败，已自动开启新会话，请继续发送。';
  }
}

function inputTokenResetEligible(
  turns: number,
  inputTokens: number,
  config: AutoNewSessionConfig,
): boolean {
  return (
    turns >= config.minTurnsBeforeInputTokenReset &&
    inputTokens >= config.inputTokenThreshold
  );
}

function resetReasonStillApplies(
  entry: ContextBudgetEntry,
  reason: ContextBudgetResetReason,
  config: AutoNewSessionConfig,
): boolean {
  switch (reason.code) {
    case 'context-error':
      return true;
    case 'input-tokens': {
      const tokens = reason.inputTokens ?? entry.maxInputTokens;
      return tokens !== undefined && inputTokenResetEligible(entry.turns, tokens, config);
    }
    case 'max-turns':
      return config.maxTurns > 0 && entry.turns >= config.maxTurns;
  }
}

function normalizeEntry(input: unknown): ContextBudgetEntry | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Partial<ContextBudgetEntry>;
  if (typeof raw.turns !== 'number' || typeof raw.updatedAt !== 'number') return undefined;
  const pendingResetReason = normalizeResetReason(raw.pendingResetReason);
  return {
    turns: Math.max(0, Math.floor(raw.turns)),
    ...(typeof raw.lastInputTokens === 'number' && Number.isFinite(raw.lastInputTokens)
      ? { lastInputTokens: Math.max(0, Math.floor(raw.lastInputTokens)) }
      : {}),
    ...(typeof raw.maxInputTokens === 'number' && Number.isFinite(raw.maxInputTokens)
      ? { maxInputTokens: Math.max(0, Math.floor(raw.maxInputTokens)) }
      : {}),
    ...(pendingResetReason ? { pendingResetReason } : {}),
    updatedAt: raw.updatedAt,
  };
}

function normalizeResetReason(input: unknown): ContextBudgetResetReason | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Partial<ContextBudgetResetReason>;
  if (
    raw.code !== 'input-tokens' &&
    raw.code !== 'max-turns' &&
    raw.code !== 'context-error'
  ) {
    return undefined;
  }
  return {
    code: raw.code,
    ...(typeof raw.inputTokens === 'number' && Number.isFinite(raw.inputTokens)
      ? { inputTokens: Math.max(0, Math.floor(raw.inputTokens)) }
      : {}),
    ...(typeof raw.threshold === 'number' && Number.isFinite(raw.threshold)
      ? { threshold: Math.max(0, Math.floor(raw.threshold)) }
      : {}),
    ...(typeof raw.turns === 'number' && Number.isFinite(raw.turns)
      ? { turns: Math.max(0, Math.floor(raw.turns)) }
      : {}),
    ...(typeof raw.maxTurns === 'number' && Number.isFinite(raw.maxTurns)
      ? { maxTurns: Math.max(0, Math.floor(raw.maxTurns)) }
      : {}),
  };
}
