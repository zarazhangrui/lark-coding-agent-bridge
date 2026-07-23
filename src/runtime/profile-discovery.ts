import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { isRootConfig, loadRootConfig, readActiveProfile } from '../config/profile-store';
import type { AgentKind } from '../config/profile-schema';

export interface DiscoveredProfile {
  name: string;
  active: boolean;
  agentKind: AgentKind;
  profileDir: string;
}

export async function listAllProfiles(rootDir?: string): Promise<DiscoveredProfile[]> {
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  if (!root) throw new Error(`root config not found: ${rootPaths.configFile}`);

  const activeProfile = (await readActiveProfile(rootPaths.rootDir)) ?? root.activeProfile;
  if (!root.profiles[activeProfile]) {
    throw new Error(`active profile not found: ${activeProfile}`);
  }

  const configured = Object.keys(root.profiles);
  const rawConfigured = await readRawConfiguredProfiles(rootPaths.configFile);
  const stateDirs = await readProfileStateDirs(rootPaths.rootDir);
  const rawConfiguredSet = new Set(rawConfigured);
  const stateSet = new Set(stateDirs);
  const missingState = configured.filter((name) => !stateSet.has(name));
  if (missingState.length > 0) {
    throw new Error(`profile state directory missing: ${missingState.join(', ')}`);
  }
  const orphanState: string[] = [];
  for (const name of stateDirs) {
    if (rawConfiguredSet.has(name)) continue;
    if (await isLogOnlyProfileState(rootPaths.rootDir, name)) continue;
    orphanState.push(name);
  }
  if (orphanState.length > 0) {
    throw new Error(`profile state directory without config: ${orphanState.join(', ')}`);
  }

  return configured
    .sort((a, b) => profileSort(a, b, activeProfile))
    .map((name) => {
      const profile = root.profiles[name];
      if (!profile) throw new Error(`profile not found: ${name}`);
      return {
        name,
        active: name === activeProfile,
        agentKind: profile.agentKind,
        profileDir: resolveAppPaths({ rootDir: rootPaths.rootDir, profile: name }).profileDir,
      };
    });
}

async function readRawConfiguredProfiles(configFile: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(configFile, 'utf8')) as unknown;
  if (!isRootConfig(raw)) return [];
  return Object.keys(raw.profiles);
}

async function readProfileStateDirs(rootDir: string): Promise<string[]> {
  const profilesDir = join(rootDir, 'profiles');
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function isLogOnlyProfileState(rootDir: string, profile: string): Promise<boolean> {
  try {
    const entries = await readdir(join(rootDir, 'profiles', profile), { withFileTypes: true });
    return entries.length === 1 && entries[0]?.isDirectory() === true && entries[0].name === 'logs';
  } catch {
    return false;
  }
}

function profileSort(a: string, b: string, active: string): number {
  if (a === active) return -1;
  if (b === active) return 1;
  return a.localeCompare(b);
}
