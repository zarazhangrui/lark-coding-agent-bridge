import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../../src/agent/pi/adapter.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('PiAdapter prepareRun', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a run when the configured pi binary returns a version', async () => {
    const binary = await writePiBinary('pi 0.79.1');
    const adapter = new PiAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'pi-profile'),
    });

    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('reports a preflight diagnostic when the configured pi binary is missing', async () => {
    const adapter = new PiAdapter({
      binary: join(tmpdir(), 'missing-pi'),
      profileStateDir: join(tmpdir(), 'pi-profile'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: 'Pi',
      },
    });
  });
});

async function writePiBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'pi', version);
}
