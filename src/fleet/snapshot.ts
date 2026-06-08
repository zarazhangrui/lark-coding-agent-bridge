import { arch as osArch, hostname as osHostname, platform as osPlatform, release as osRelease, userInfo } from 'node:os';
import pkg from '../../package.json';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig } from '../config/profile-store';
import type { AgentKind } from '../config/profile-schema';
import type { TenantBrand } from '../config/schema';
import { isAlive, readAndPrune, type ProcessEntry } from '../runtime/registry';
import type { FleetAssistant, FleetManifest } from './manifest';

export interface BuildFleetSnapshotOptions {
  rootDir?: string;
  now?: () => Date;
  hostname?: () => string;
  platform?: () => NodeJS.Platform;
  arch?: () => string;
  release?: () => string;
  username?: () => string;
}

export interface FleetProfileSnapshot {
  name: string;
  agentKind: AgentKind;
  appId: string;
  tenant: TenantBrand;
  defaultWorkspace?: string;
}

export interface FleetProcessSnapshot extends ProcessEntry {
  alive: boolean;
}

export interface FleetSnapshot {
  schemaVersion: 1;
  bridgeVersion: string;
  capturedAt: string;
  rootDir: string;
  host: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    username: string;
  };
  profiles: FleetProfileSnapshot[];
  processes: FleetProcessSnapshot[];
}

export type AssistantFleetStatus = FleetAssistant & {
  configured: boolean;
  online: boolean;
  snapshotHost?: string;
  profileNameActual?: string;
  botNameActual?: string;
  pid?: number;
  version?: string;
  status: 'online' | 'configured_offline' | 'missing_profile';
};

export interface FleetStatusReport {
  schemaVersion: 1;
  capturedAt: string;
  fleetName: string;
  totalAssistants: number;
  onlineAssistants: number;
  snapshots: Array<{
    hostname: string;
    capturedAt: string;
    processCount: number;
    onlineProcessCount: number;
  }>;
  assistants: AssistantFleetStatus[];
}

export function isFleetSnapshot(input: unknown): input is FleetSnapshot {
  if (!input || typeof input !== 'object') return false;
  const snapshot = input as Partial<FleetSnapshot>;
  const host = snapshot.host as Partial<FleetSnapshot['host']> | undefined;
  return (
    snapshot.schemaVersion === 1 &&
    typeof snapshot.bridgeVersion === 'string' &&
    typeof snapshot.capturedAt === 'string' &&
    typeof snapshot.rootDir === 'string' &&
    Boolean(host && typeof host.hostname === 'string') &&
    Array.isArray(snapshot.profiles) &&
    Array.isArray(snapshot.processes)
  );
}

export async function buildFleetSnapshot(options: BuildFleetSnapshotOptions = {}): Promise<FleetSnapshot> {
  const paths = resolveAppPaths({ rootDir: options.rootDir });
  const root = await loadRootConfig(paths.configFile);
  const profiles: FleetProfileSnapshot[] = root
    ? Object.entries(root.profiles).map(([name, profile]) => ({
      name,
      agentKind: profile.agentKind,
      appId: profile.accounts.app.id,
      tenant: profile.accounts.app.tenant,
      ...(profile.workspaces.default ? { defaultWorkspace: profile.workspaces.default } : {}),
    }))
    : [];
  const processes = readAndPrune(paths.userRegistryFile).map((entry) => ({
    ...entry,
    alive: isAlive(entry.pid),
  }));

  return {
    schemaVersion: 1,
    bridgeVersion: pkg.version,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    rootDir: paths.rootDir,
    host: {
      hostname: options.hostname?.() ?? osHostname(),
      platform: options.platform?.() ?? osPlatform(),
      arch: options.arch?.() ?? osArch(),
      release: options.release?.() ?? osRelease(),
      username: options.username?.() ?? safeUsername(),
    },
    profiles,
    processes,
  };
}

export function buildFleetStatus(manifest: FleetManifest, input: FleetSnapshot | FleetSnapshot[]): FleetStatusReport {
  const snapshots = Array.isArray(input) ? input : [input];
  const profilesByApp = new Map(snapshots.flatMap((snapshot) => (
    snapshot.profiles.map((profile) => [profile.appId, { profile, snapshot }] as const)
  )));
  const processesByApp = new Map(
    snapshots.flatMap((snapshot) => snapshot.processes
      .filter((entry) => entry.alive)
      .map((entry) => [entry.appId, { entry, snapshot }] as const)),
  );
  const assistants = manifest.assistants.map((assistant): AssistantFleetStatus => {
    const profileMatch = profilesByApp.get(assistant.appId);
    const processMatch = processesByApp.get(assistant.appId);
    const online = Boolean(processMatch);
    const configured = Boolean(profileMatch);
    return {
      ...assistant,
      configured,
      online,
      ...(processMatch ? { snapshotHost: processMatch.snapshot.host.hostname } : {}),
      ...(profileMatch ? { profileNameActual: profileMatch.profile.name } : {}),
      ...(processMatch?.entry.botName ? { botNameActual: processMatch.entry.botName } : {}),
      ...(processMatch ? { pid: processMatch.entry.pid, version: processMatch.entry.version } : {}),
      status: online ? 'online' : configured ? 'configured_offline' : 'missing_profile',
    };
  });
  const capturedAt = snapshots
    .map((snapshot) => snapshot.capturedAt)
    .sort()
    .at(-1) ?? new Date(0).toISOString();
  return {
    schemaVersion: 1,
    capturedAt,
    fleetName: manifest.fleetName,
    totalAssistants: assistants.length,
    onlineAssistants: assistants.filter((assistant) => assistant.online).length,
    snapshots: snapshots.map((snapshot) => ({
      hostname: snapshot.host.hostname,
      capturedAt: snapshot.capturedAt,
      processCount: snapshot.processes.length,
      onlineProcessCount: snapshot.processes.filter((entry) => entry.alive).length,
    })),
    assistants,
  };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}
