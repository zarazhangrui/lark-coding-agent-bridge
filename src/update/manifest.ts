export const BUNDLE_SCHEMA = 'lark-channel-bundle.v1';
export const FIXED_PACKAGES = {
  bridge: 'lark-channel-bridge', codex: '@openai/codex', larkCli: '@larksuite/cli',
} as const;
export const SUPPORTED_PROTOCOL_REVISIONS = [
  'codex-app-server-0.141',
  'codex-app-server-0.150',
  'codex-app-server-0.153',
] as const;

export interface CompatibilityBundle {
  schema: typeof BUNDLE_SCHEMA;
  bundleVersion: string;
  protocolRevision: string;
  components: { bridge: Component; codex: Component; larkCli: Component };
}
export interface Component { package: string; version: string; integrity: string }

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function validateBundle(input: unknown): CompatibilityBundle {
  if (!input || typeof input !== 'object') throw new Error('bundle manifest must be an object');
  const raw = input as Partial<CompatibilityBundle>;
  if (raw.schema !== BUNDLE_SCHEMA || typeof raw.bundleVersion !== 'string' || !EXACT_SEMVER.test(raw.bundleVersion) || typeof raw.protocolRevision !== 'string' || !raw.protocolRevision) throw new Error('invalid bundle metadata');
  const components = raw.components as Record<string, Component> | undefined;
  for (const [key, packageName] of Object.entries(FIXED_PACKAGES)) {
    const component = components?.[key];
    if (!component || component.package !== packageName || !EXACT_SEMVER.test(component.version) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(component.integrity)) throw new Error(`invalid exact component: ${key}`);
  }
  return raw as CompatibilityBundle;
}

export function safeBundleDirName(version: string): string {
  if (!EXACT_SEMVER.test(version) || version.includes('/') || version.includes('\\') || version.includes('..')) throw new Error('unsafe bundle version path');
  return version;
}

export function assertSupportedProtocolRevision(revision: string): void {
  if (!(SUPPORTED_PROTOCOL_REVISIONS as readonly string[]).includes(revision)) {
    throw new Error(`unsupported protocol revision: ${revision}`);
  }
}
