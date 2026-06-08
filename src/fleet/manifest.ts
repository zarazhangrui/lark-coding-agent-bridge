import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind } from '../config/profile-schema';
import type { TenantBrand } from '../config/schema';

export interface FleetMachine {
  id: string;
  displayName: string;
  platform: NodeJS.Platform;
  sshHosts: string[];
  stateRoot: string;
}

export interface FleetAssistant {
  id: string;
  machineId: string;
  agentKind: AgentKind;
  profileName: string;
  botName: string;
  appId: string;
  tenant: TenantBrand;
  sshHost: string;
  feishuLabel: string;
}

export interface FleetGroup {
  name: string;
  description?: string;
}

export interface FleetManifest {
  schemaVersion: 1;
  fleetName: string;
  repository: string;
  lastAuditedAt: string;
  machines: FleetMachine[];
  assistants: FleetAssistant[];
  groups: FleetGroup[];
}

export interface FleetManifestSummary {
  fleetName: string;
  assistants: number;
  machines: Record<string, Record<AgentKind, number>>;
}

export function defaultFleetManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const relativeCandidates = [
    join(here, '..', '..', 'fleet', 'fusionbridge.assistants.json'),
    join(here, '..', 'fleet', 'fusionbridge.assistants.json'),
    join(process.cwd(), 'fleet', 'fusionbridge.assistants.json'),
  ];
  return relativeCandidates.find((candidate) => existsSync(candidate)) ?? relativeCandidates[0] ?? '';
}

export async function loadDefaultFleetManifest(): Promise<FleetManifest> {
  return loadFleetManifest(defaultFleetManifestPath());
}

export async function loadFleetManifest(path: string): Promise<FleetManifest> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return normalizeFleetManifest(parsed);
}

export function summarizeFleetManifest(manifest: FleetManifest): FleetManifestSummary {
  const machines: Record<string, Record<AgentKind, number>> = {};
  for (const machine of manifest.machines) {
    machines[machine.id] = { claude: 0, codex: 0 };
  }
  for (const assistant of manifest.assistants) {
    const summary = machines[assistant.machineId];
    if (summary) summary[assistant.agentKind] += 1;
  }
  return {
    fleetName: manifest.fleetName,
    assistants: manifest.assistants.length,
    machines,
  };
}

function normalizeFleetManifest(input: unknown): FleetManifest {
  if (!input || typeof input !== 'object') throw new Error('fleet manifest must be an object');
  const raw = input as Partial<FleetManifest>;
  if (raw.schemaVersion !== 1) throw new Error('fleet manifest schemaVersion must be 1');
  if (typeof raw.fleetName !== 'string' || !raw.fleetName.trim()) {
    throw new Error('fleet manifest fleetName is required');
  }
  if (typeof raw.repository !== 'string' || !raw.repository.trim()) {
    throw new Error('fleet manifest repository is required');
  }
  if (typeof raw.lastAuditedAt !== 'string' || !raw.lastAuditedAt.trim()) {
    throw new Error('fleet manifest lastAuditedAt is required');
  }
  if (!Array.isArray(raw.machines)) throw new Error('fleet manifest machines must be an array');
  if (!Array.isArray(raw.assistants)) throw new Error('fleet manifest assistants must be an array');
  if (!Array.isArray(raw.groups)) throw new Error('fleet manifest groups must be an array');

  const machines = raw.machines.map(normalizeMachine);
  const machineIds = new Set(machines.map((machine) => machine.id));
  const assistants = raw.assistants.map((assistant) => normalizeAssistant(assistant, machineIds));
  assertUnique('machine id', machines.map((machine) => machine.id));
  assertUnique('assistant id', assistants.map((assistant) => assistant.id));
  assertUnique('assistant appId', assistants.map((assistant) => assistant.appId));

  return {
    schemaVersion: 1,
    fleetName: raw.fleetName,
    repository: raw.repository,
    lastAuditedAt: raw.lastAuditedAt,
    machines,
    assistants,
    groups: raw.groups.map(normalizeGroup),
  };
}

function normalizeMachine(input: unknown): FleetMachine {
  if (!input || typeof input !== 'object') throw new Error('fleet machine must be an object');
  const raw = input as Partial<FleetMachine>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('fleet machine id is required');
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) {
    throw new Error(`fleet machine ${raw.id} displayName is required`);
  }
  if (raw.platform !== 'darwin' && raw.platform !== 'win32' && raw.platform !== 'linux') {
    throw new Error(`fleet machine ${raw.id} platform is invalid`);
  }
  if (!Array.isArray(raw.sshHosts) || raw.sshHosts.length === 0 || !raw.sshHosts.every(isNonEmptyString)) {
    throw new Error(`fleet machine ${raw.id} sshHosts are required`);
  }
  if (typeof raw.stateRoot !== 'string' || !raw.stateRoot.trim()) {
    throw new Error(`fleet machine ${raw.id} stateRoot is required`);
  }
  return {
    id: raw.id,
    displayName: raw.displayName,
    platform: raw.platform,
    sshHosts: raw.sshHosts,
    stateRoot: raw.stateRoot,
  };
}

function normalizeAssistant(input: unknown, machineIds: Set<string>): FleetAssistant {
  if (!input || typeof input !== 'object') throw new Error('fleet assistant must be an object');
  const raw = input as Partial<FleetAssistant>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('fleet assistant id is required');
  if (typeof raw.machineId !== 'string' || !machineIds.has(raw.machineId)) {
    throw new Error(`fleet assistant ${raw.id} references unknown machineId`);
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex') {
    throw new Error(`fleet assistant ${raw.id} agentKind is invalid`);
  }
  for (const field of ['profileName', 'botName', 'appId', 'sshHost', 'feishuLabel'] as const) {
    if (typeof raw[field] !== 'string' || !raw[field]?.trim()) {
      throw new Error(`fleet assistant ${raw.id} ${field} is required`);
    }
  }
  if (raw.tenant !== 'feishu' && raw.tenant !== 'lark') {
    throw new Error(`fleet assistant ${raw.id} tenant is invalid`);
  }
  return {
    id: raw.id,
    machineId: raw.machineId,
    agentKind: raw.agentKind,
    profileName: raw.profileName ?? '',
    botName: raw.botName ?? '',
    appId: raw.appId ?? '',
    tenant: raw.tenant,
    sshHost: raw.sshHost ?? '',
    feishuLabel: raw.feishuLabel ?? '',
  };
}

function normalizeGroup(input: unknown): FleetGroup {
  if (!input || typeof input !== 'object') throw new Error('fleet group must be an object');
  const raw = input as Partial<FleetGroup>;
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('fleet group name is required');
  return {
    name: raw.name,
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertUnique(label: string, values: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
