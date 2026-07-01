import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../../../src/agent/opencode/adapter.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('OpenCodeAdapter prepareRun', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a run when the configured OpenCode binary returns a version', async () => {
    const binary = await writeOpenCodeBinary('opencode 1.2.3');
    const adapter = new OpenCodeAdapter({ binary });

    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('reports a preflight diagnostic when the configured OpenCode binary is missing', async () => {
    const adapter = new OpenCodeAdapter({
      binary: join(tmpdir(), 'missing-opencode'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'opencode',
        agentName: 'OpenCode',
      },
    });
  });
});

async function writeOpenCodeBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'opencode', version);
}
