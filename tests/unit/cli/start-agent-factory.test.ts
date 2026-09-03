import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
import { OpencodeAdapter } from '../../../src/agent/opencode/adapter.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';

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

  it('creates an Opencode runtime agent when an opencode profile has a binary path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'opencode',
        accounts: appAccount(),
        opencode: { binaryPath: '/usr/local/bin/opencode' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/opencode-e2e' },
    );

    expect(agent.id).toBe('opencode');
    expect(agent.displayName).toBe('OpenCode');
    expect(agent).toBeInstanceOf(OpencodeAdapter);
  });

  it('seeds a default Codex binary when bootstrapping a new Codex profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
    });

    expect(profile.codex?.binaryPath).toBe('codex');
  });

  it('seeds a default Opencode binary when bootstrapping a new Opencode profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'opencode',
      accounts: appAccount(),
    });

    expect(profile.opencode?.binaryPath).toBe('opencode');
  });

  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    // Reconnect ordering now lives in the supervisor's ManagedProfile.restart().
    const source = await readFile(join(process.cwd(), 'src/runtime/supervisor.ts'), 'utf8');
    const restartStart = source.indexOf('async restart()');
    const updateIndex = source.indexOf('updateEntry(', restartStart);
    const releaseIndex = source.indexOf('oldAppLock?.release()', restartStart);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(releaseIndex);
  });

  it('shuts down the supervisor (releasing profile locks) before exiting', async () => {
    // Graceful shutdown: the supervisor stops all channels (releasing each
    // profile's locks) before the process exits.
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const stopStart = source.indexOf('const shutdown = async');
    const shutdownIndex = source.indexOf('await supervisor.shutdown()', stopStart);
    const exitIndex = source.indexOf('process.exit(0)', stopStart);

    expect(stopStart).toBeGreaterThanOrEqual(0);
    expect(shutdownIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(shutdownIndex).toBeLessThan(exitIndex);

    // And each channel's teardown releases its runtime locks.
    const sup = await readFile(join(process.cwd(), 'src/runtime/supervisor.ts'), 'utf8');
    expect(sup).toContain('releaseRuntimeLocks(this.locks)');
  });

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
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
