import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';
import { PiAdapter } from '../../../src/agent/pi/adapter.js';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';

describe('start runtime agent factory', () => {
  it('keeps Claude as the default runtime agent', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: appAccount(),
      }),
      { profileDir: tmpdir() },
    );

    expect(agent.id).toBe('claude');
    expect(agent.displayName).toBe('Claude Code');
  });

  it('creates CodexAdapter from canonical workspace permissions', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
      codex: codexConfig(),
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e',
    });

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
    expect(profile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('creates a Codex runtime agent when an older profile has only a binary path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: appAccount(),
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e' },
    );

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
  });

  it('seeds a default Codex binary when bootstrapping a new Codex profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
    });

    expect(profile.codex?.binaryPath).toBe('codex');
  });

  it('creates PiAdapter from a pi profile', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: appAccount(),
      pi: { binaryPath: '/usr/local/bin/pi', inheritPiHome: false },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-channel-bridge/profiles/pi-e2e',
    });

    expect(agent).toBeInstanceOf(PiAdapter);
    expect(agent.id).toBe('pi');
    expect(agent.displayName).toBe('Pi');
  });

  it('throws when a pi profile is missing pi.binaryPath', () => {
    expect(() =>
      createRuntimeAgent(
        createDefaultProfileConfig({
          agentKind: 'pi',
          accounts: appAccount(),
          pi: {} as { binaryPath: string },
        }),
        { profileDir: tmpdir() },
      ),
    ).toThrow('pi profile requires pi.binaryPath');
  });

  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const restartStart = source.indexOf('async restart()');
    const updateIndex = source.indexOf('await updateEntry(entry.id', restartStart);
    const releaseIndex = source.indexOf('await oldAppLock?.release()', restartStart);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(releaseIndex);
  });

  it('releases the current runtime locks during graceful shutdown', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const stopStart = source.indexOf('const stop = async');
    const releaseIndex = source.indexOf('await releaseRuntimeLocks(runtimeLocks)', stopStart);
    const exitIndex = source.indexOf('process.exit(0)', stopStart);

    expect(stopStart).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(exitIndex);
  });

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
  });

  it('reports agentId/command as pi (not claude) when a pi adapter is unavailable', async () => {
    const fakePiAgent: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return false;
      },
      run(_opts: AgentRunOptions): AgentRun {
        throw new Error('not implemented');
      },
    };

    const availability = await checkRuntimeAgentAvailability(fakePiAgent);

    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.diagnostic.agentId).toBe('pi');
      expect(availability.diagnostic.agentName).toBe(fakePiAgent.displayName);
      expect(availability.diagnostic.command).toBe('pi');
    }
  });
});

function appAccount() {
  return {
    app: {
      id: 'cli_xxx',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}

function codexConfig() {
  return {
    binaryPath: '/usr/local/bin/codex',
    realpath: '/usr/local/bin/codex',
    version: 'codex 1.2.3',
    sha256: '0'.repeat(64),
    owner: 501,
    mode: 0o755,
  };
}
