import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SESSION_CONTEXT_FILE_ENV,
  SESSION_CONTEXT_MAX_BYTES,
  readSessionContextFileFromEnv,
} from '../../../src/agent/session-context-file';

describe('session context file', () => {
  it('reads the configured handoff file from the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-context-'));
    const file = join(dir, 'handoff.md');
    await writeFile(file, '# Handoff\n- next: test\n', 'utf8');

    await expect(readSessionContextFileFromEnv({ [SESSION_CONTEXT_FILE_ENV]: file })).resolves.toEqual({
      path: file,
      content: '# Handoff\n- next: test\n',
      bytes: 23,
    });
  });

  it('truncates oversized context files before prompt injection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-context-'));
    const file = join(dir, 'handoff.md');
    await writeFile(file, 'x'.repeat(SESSION_CONTEXT_MAX_BYTES + 3), 'utf8');

    const context = await readSessionContextFileFromEnv({ [SESSION_CONTEXT_FILE_ENV]: file });

    expect(context?.bytes).toBe(SESSION_CONTEXT_MAX_BYTES + 3);
    expect(context?.truncated).toBe(true);
    expect(context?.content).toHaveLength(SESSION_CONTEXT_MAX_BYTES);
  });
});
