import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFleetSnapshot,
  buildFleetStatus,
  isFleetSnapshot,
  type FleetSnapshot,
} from '../../fleet/snapshot';
import {
  loadDefaultFleetManifest,
  loadFleetManifest,
  summarizeFleetManifest,
  type FleetManifest,
} from '../../fleet/manifest';

interface OutputOptions {
  json?: boolean;
}

export async function runFleetManifest(opts: OutputOptions & { manifest?: string } = {}): Promise<void> {
  const manifest = await loadManifest(opts.manifest);
  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  const summary = summarizeFleetManifest(manifest);
  console.log(`${summary.fleetName}: ${summary.assistants} assistants`);
  for (const [machine, counts] of Object.entries(summary.machines)) {
    console.log(`- ${machine}: Claude Code ${counts.claude}, Codex ${counts.codex}`);
  }
}

export async function runFleetSnapshot(opts: OutputOptions & { rootDir?: string } = {}): Promise<void> {
  const snapshot = await buildFleetSnapshot({ rootDir: opts.rootDir });
  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printSnapshot(snapshot);
}

export async function runFleetStatus(
  opts: OutputOptions & { manifest?: string; rootDir?: string; snapshotsDir?: string } = {},
): Promise<void> {
  const [manifest, snapshots] = await Promise.all([
    loadManifest(opts.manifest),
    opts.snapshotsDir ? loadSnapshotsDir(opts.snapshotsDir) : buildFleetSnapshot({ rootDir: opts.rootDir }),
  ]);
  const status = buildFleetStatus(manifest, snapshots);
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`${status.fleetName}: ${status.onlineAssistants}/${status.totalAssistants} assistants online`);
  for (const assistant of status.assistants) {
    const marker = assistant.online ? 'online' : assistant.configured ? 'offline' : 'missing';
    const pid = assistant.pid ? ` pid=${assistant.pid}` : '';
    console.log(`- ${assistant.id} ${assistant.botName}: ${marker}${pid}`);
  }
}

async function loadManifest(path?: string): Promise<FleetManifest> {
  return path ? loadFleetManifest(path) : loadDefaultFleetManifest();
}

function printSnapshot(snapshot: FleetSnapshot): void {
  const online = snapshot.processes.filter((entry) => entry.alive).length;
  console.log(`${snapshot.host.hostname}: ${online}/${snapshot.processes.length} bridge processes alive`);
  console.log(`root: ${snapshot.rootDir}`);
  for (const processEntry of snapshot.processes) {
    const marker = processEntry.alive ? 'online' : 'stale';
    const bot = processEntry.botName ?? processEntry.appId;
    console.log(`- ${marker} ${bot} profile=${processEntry.profileName} pid=${processEntry.pid}`);
  }
}

async function loadSnapshotsDir(path: string): Promise<FleetSnapshot[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(path, entry.name))
    .sort();
  const snapshots = (await Promise.all(files.map(async (file) => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return isFleetSnapshot(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }))).filter((snapshot): snapshot is FleetSnapshot => Boolean(snapshot));
  if (snapshots.length === 0) throw new Error(`no snapshot JSON files found in ${path}`);
  return snapshots;
}
