import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
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

  it('seeds a default Codex binary when bootstrapping a new Codex profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
    });

    expect(profile.codex?.binaryPath).toBe('codex');
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

  it('creates OpenCodeAdapter from opencode profile config', () => {
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
  });

  it('seeds a default OpenCode binary when bootstrapping a new OpenCode profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'opencode',
      accounts: appAccount(),
    });

    expect(profile.opencode?.binaryPath).toBe('opencode');
  });

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
    expect(() => assertReconnectAgentKindUnchanged('opencode', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('opencode', 'opencode')).not.toThrow();
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
