import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import type { FleetManifest } from '../../../src/fleet/manifest';
import {
  buildFleetSnapshot,
  buildFleetStatus,
  isFleetSnapshot,
  type FleetSnapshot,
} from '../../../src/fleet/snapshot';
import type { ProcessEntry } from '../../../src/runtime/registry';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-fleet-snapshot-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('buildFleetSnapshot', () => {
  it('exports local profiles and process registry status without secrets', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'registry'), { recursive: true });
    await writeRootConfig(root);
    await writeFile(join(root, 'registry', 'processes.json'), JSON.stringify({
      entries: [
        entry({
          id: 'live',
          pid: process.pid,
          appId: 'cli_claude',
          profileName: 'claude',
          agentKind: 'claude',
          botName: 'Mac2CC Assistant',
        }),
        entry({
          id: 'dead',
          pid: 999_999_991,
          appId: 'cli_codex',
          profileName: 'codex',
          agentKind: 'codex',
          botName: 'Mac2CD Assistant',
        }),
      ],
    }, null, 2));

    const snapshot = await buildFleetSnapshot({
      rootDir: root,
      now: () => new Date('2026-06-07T19:00:00.000Z'),
      hostname: () => 'Mac2.local',
      platform: () => 'darwin',
    });

    expect(snapshot.capturedAt).toBe('2026-06-07T19:00:00.000Z');
    expect(snapshot.host.hostname).toBe('Mac2.local');
    expect(snapshot.profiles).toEqual([
      {
        name: 'claude',
        agentKind: 'claude',
        appId: 'cli_claude',
        tenant: 'feishu',
        defaultWorkspace: '/work/claude',
      },
      {
        name: 'codex',
        agentKind: 'codex',
        appId: 'cli_codex',
        tenant: 'feishu',
        defaultWorkspace: '/work/codex',
      },
    ]);
    expect(snapshot.processes.map((item) => ({
      id: item.id,
      alive: item.alive,
      botName: item.botName,
    }))).toEqual([
      { id: 'live', alive: true, botName: 'Mac2CC Assistant' },
      { id: 'dead', alive: false, botName: 'Mac2CD Assistant' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('super-secret');
  });

  it('builds a fleet status report from multiple machine snapshots', () => {
    const manifest: FleetManifest = {
      schemaVersion: 1,
      fleetName: 'FusionBridge',
      repository: 'https://example.test/repo',
      lastAuditedAt: '2026-06-07T19:00:00.000Z',
      machines: [],
      groups: [],
      assistants: [
        assistant({ id: 'mac1-cc', machineId: 'mac1', appId: 'cli_mac1_cc' }),
        assistant({ id: 'win4-cd', machineId: 'win4', appId: 'cli_win4_cd', agentKind: 'codex' }),
      ],
    };

    const report = buildFleetStatus(manifest, [
      snapshot({ hostname: 'Mac1.local', appId: 'cli_mac1_cc', botName: 'Mac1CC Assistant' }),
      snapshot({ hostname: 'Win4', appId: 'cli_win4_cd', botName: 'Win4CD Assistant' }),
    ]);

    expect(report.onlineAssistants).toBe(2);
    expect(report.assistants.map((item) => ({
      id: item.id,
      online: item.online,
      snapshotHost: item.snapshotHost,
      botNameActual: item.botNameActual,
    }))).toEqual([
      { id: 'mac1-cc', online: true, snapshotHost: 'Mac1.local', botNameActual: 'Mac1CC Assistant' },
      { id: 'win4-cd', online: true, snapshotHost: 'Win4', botNameActual: 'Win4CD Assistant' },
    ]);
  });

  it('distinguishes snapshots from status reports', () => {
    expect(isFleetSnapshot(snapshot({
      hostname: 'Mac1.local',
      appId: 'cli_mac1_cc',
      botName: 'Mac1CC Assistant',
    }))).toBe(true);
    expect(isFleetSnapshot({
      schemaVersion: 1,
      fleetName: 'FusionBridge',
      assistants: [],
    })).toBe(false);
  });
});

async function writeRootConfig(root: string): Promise<void> {
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: {
        ...createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: { app: { id: 'cli_claude', secret: 'super-secret', tenant: 'feishu' } },
        }),
        workspaces: { default: '/work/claude' },
      },
      codex: {
        ...createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { id: 'cli_codex', secret: 'super-secret', tenant: 'feishu' } },
        codex: { binaryPath: 'codex' },
        }),
        workspaces: { default: '/work/codex' },
      },
    },
  };
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function entry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_default',
    tenant: 'feishu',
    profileName: 'claude',
    agentKind: 'claude',
    configPath: '/tmp/config.json',
    startedAt: '2026-06-07T18:00:00.000Z',
    version: '0.2.2',
    ...overrides,
  };
}

function assistant(overrides: Partial<FleetManifest['assistants'][number]>): FleetManifest['assistants'][number] {
  return {
    id: 'assistant',
    machineId: 'mac1',
    agentKind: 'claude',
    profileName: 'claude',
    botName: 'Assistant',
    appId: 'cli_app',
    tenant: 'feishu',
    sshHost: 'mac1',
    feishuLabel: 'Claude Code',
    ...overrides,
  };
}

function snapshot(input: { hostname: string; appId: string; botName: string }): FleetSnapshot {
  return {
    schemaVersion: 1,
    bridgeVersion: '0.2.2',
    capturedAt: '2026-06-07T19:00:00.000Z',
    rootDir: '/state',
    host: {
      hostname: input.hostname,
      platform: 'darwin',
      arch: 'arm64',
      release: '1.0',
      username: 'jay520',
    },
    profiles: [
      {
        name: 'claude',
        agentKind: 'claude',
        appId: input.appId,
        tenant: 'feishu',
      },
    ],
    processes: [
      {
        ...entry({
        id: input.appId.slice(-4),
        appId: input.appId,
        botName: input.botName,
        }),
        alive: true,
      },
    ],
  };
}
