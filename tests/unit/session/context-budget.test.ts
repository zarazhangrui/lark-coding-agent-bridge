import { describe, expect, it } from 'vitest';
import { getAutoNewSessionConfig } from '../../../src/config/schema';
import {
  ContextBudgetStore,
  isContextLimitError,
} from '../../../src/session/context-budget';

describe('context budget store', () => {
  it('defaults auto-new to 100000 input tokens, 3 token-gated turns, and 8 max turns', () => {
    expect(getAutoNewSessionConfig({ accounts: { app }, preferences: {} })).toEqual({
      enabled: true,
      inputTokenThreshold: 100_000,
      minTurnsBeforeInputTokenReset: 3,
      maxTurns: 8,
    });
  });

  it('does not mark a pending token reset after a single high-token turn', () => {
    const store = new ContextBudgetStore();
    const config = getAutoNewSessionConfig({ accounts: { app }, preferences: {} });

    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'done', inputTokens: 100_001 },
        config,
      ),
    ).toBeUndefined();
    expect(store.pendingResetFor('chat-1', config)).toBeUndefined();
  });

  it('marks a pending reset when input tokens cross the threshold after enough turns', () => {
    const store = new ContextBudgetStore();
    const config = getAutoNewSessionConfig({ accounts: { app }, preferences: {} });

    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'done', inputTokens: 100_001 },
        config,
      ),
    ).toBeUndefined();
    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'done', inputTokens: 100_001 },
        config,
      ),
    ).toBeUndefined();

    const reason = store.recordRunResult(
      'chat-1',
      { terminal: 'done', inputTokens: 100_001 },
      config,
    );

    expect(reason).toMatchObject({ code: 'input-tokens', inputTokens: 100_001 });
    expect(store.pendingResetFor('chat-1', config)).toMatchObject({
      code: 'input-tokens',
      inputTokens: 100_001,
    });
  });

  it('can opt back into one-turn token resets', () => {
    const store = new ContextBudgetStore();
    const config = getAutoNewSessionConfig({
      accounts: { app },
      preferences: { autoNewSession: { minTurnsBeforeInputTokenReset: 1 } },
    });

    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'done', inputTokens: 100_001 },
        config,
      ),
    ).toMatchObject({ code: 'input-tokens', inputTokens: 100_001 });
  });

  it('rechecks older one-turn pending token resets against the current gate', () => {
    const store = new ContextBudgetStore();
    const strictConfig = getAutoNewSessionConfig({
      accounts: { app },
      preferences: { autoNewSession: { minTurnsBeforeInputTokenReset: 1 } },
    });
    const relaxedConfig = getAutoNewSessionConfig({ accounts: { app }, preferences: {} });

    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'done', inputTokens: 100_001 },
        strictConfig,
      ),
    ).toMatchObject({ code: 'input-tokens' });

    expect(store.pendingResetFor('chat-1', relaxedConfig)).toBeUndefined();
  });

  it('uses maxTurns as a fallback when usage is unavailable', () => {
    const store = new ContextBudgetStore();
    const config = getAutoNewSessionConfig({
      accounts: { app },
      preferences: { autoNewSession: { maxTurns: 2 } },
    });

    expect(store.recordRunResult('chat-1', { terminal: 'done' }, config)).toBeUndefined();
    expect(store.recordRunResult('chat-1', { terminal: 'done' }, config)).toMatchObject({
      code: 'max-turns',
      turns: 2,
    });
  });

  it('detects context-limit errors and clears reset state', () => {
    const store = new ContextBudgetStore();
    const config = getAutoNewSessionConfig({ accounts: { app }, preferences: {} });

    expect(isContextLimitError('maximum context length exceeded')).toBe(true);
    expect(isContextLimitError('context_length_exceeded')).toBe(true);
    expect(isContextLimitError('max_tokens exceeded')).toBe(true);
    expect(
      store.recordRunResult(
        'chat-1',
        { terminal: 'error', errorMessage: 'maximum context length exceeded' },
        config,
      ),
    ).toMatchObject({ code: 'context-error' });

    store.reset('chat-1');
    expect(store.pendingResetFor('chat-1', config)).toBeUndefined();
  });
});

const app = {
  id: 'cli_test',
  secret: 'secret',
  tenant: 'feishu' as const,
};
