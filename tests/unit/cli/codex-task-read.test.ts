import { describe, expect, it } from 'vitest';
import { runCodexTaskRead } from '../../../src/cli/commands/codex-task';

describe('codex-task read CLI validation', () => {
  it.each(['', '0', '51', '1.5', '5messages'])(
    'rejects a non-integer or out-of-range --limit before resolving profile state: %j',
    async (limit) => {
      await expect(runCodexTaskRead('T-A1B2C3', {
        rootDir: '/profile-state-must-not-be-read',
        limit,
      })).rejects.toThrow('--limit must be an integer between 1 and 50');
    },
  );
});
