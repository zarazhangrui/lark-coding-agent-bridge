import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSupportedProtocolRevision, validateBundle, type CompatibilityBundle } from '../../../src/update/manifest.js';
import { npmInstallArgs, UpdateManager, withUpdateLock } from '../../../src/update/manager.js';
import { resolveUpdatePaths } from '../../../src/update/paths.js';

const integrity = 'sha512-YQ==';
const manifest = { schema: 'lark-channel-bundle.v1', bundleVersion: '1.2.3', protocolRevision: 'p1', components: { bridge: { package: 'lark-channel-bridge', version: '1.2.3', integrity }, codex: { package: '@openai/codex', version: '0.141.0', integrity }, larkCli: { package: '@larksuite/cli', version: '1.0.76', integrity } } };
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'updater-')); const paths = resolveUpdatePaths(join(root, 'runtime')); const file = join(root, 'manifest.json'); await writeFile(file, JSON.stringify(manifest)); return { root, paths, file }; }

describe('compatibility bundle updater', () => {
  it('rejects package substitution, ranges, and traversal versions', () => {
    expect(() => validateBundle({ ...manifest, components: { ...manifest.components, codex: { package: 'evil', version: '0.141.0', integrity } } })).toThrow();
    expect(() => validateBundle({ ...manifest, components: { ...manifest.components, codex: { package: '@openai/codex', version: '^0.141.0', integrity } } })).toThrow();
    expect(() => validateBundle({ ...manifest, bundleVersion: '../1.2.3' })).toThrow();
  });
  it('accepts the rollback and current Codex App Server protocol revisions', () => {
    expect(() => assertSupportedProtocolRevision('codex-app-server-0.141')).not.toThrow();
    expect(() => assertSupportedProtocolRevision('codex-app-server-0.150')).not.toThrow();
    expect(() => assertSupportedProtocolRevision('codex-app-server-0.153')).not.toThrow();
    expect(() => assertSupportedProtocolRevision('codex-app-server-0.154')).toThrow(
      /unsupported protocol revision/,
    );
  });
  it('does not switch the active pointer when install or health fails', async () => {
    const f = await fixture(); await mkdir(f.paths.root, { recursive: true }); const old = { bundleVersion: '1.0.0', releaseDir: join(f.paths.releases, '1.0.0'), components: manifest.components, protocolRevision: 'old', verifiedAt: 'x' }; await writeFile(f.paths.current, JSON.stringify(old));
    const manager = new UpdateManager({ paths: f.paths, install: async () => { throw new Error('download failed'); }, health: async () => {} });
    await expect(manager.apply(f.file)).rejects.toThrow('download failed'); expect(JSON.parse(await readFile(f.paths.current, 'utf8'))).toEqual(old);
  });
  it('atomically activates and rolls back verified releases without touching profile data', async () => {
    const f = await fixture(); const profile = join(f.root, 'profiles', 'p', 'sessions.json'); await mkdir(join(f.root, 'profiles', 'p'), { recursive: true }); await writeFile(profile, 'user-data');
    const install = async (_bundle: unknown, dir: string) => { for (const c of Object.values(manifest.components)) { const d = join(dir, 'node_modules', c.package); await mkdir(d, { recursive: true }); await writeFile(join(d, 'package.json'), JSON.stringify({ version: c.version })); } const dist = join(dir, 'node_modules', 'lark-channel-bridge', 'dist'); await mkdir(dist, { recursive: true }); await writeFile(join(dist, 'cli.js'), ''); };
    const manager = new UpdateManager({ paths: f.paths, install, health: async () => {} }); const first = await manager.apply(f.file); expect(first.bundleVersion).toBe('1.2.3'); await writeFile(f.file, JSON.stringify({ ...manifest, bundleVersion: '1.2.4', components: { ...manifest.components, bridge: { ...manifest.components.bridge, version: '1.2.4' } } }));
    const installNext = async (bundle: CompatibilityBundle, dir: string) => { for (const c of Object.values(bundle.components)) { const d = join(dir, 'node_modules', c.package); await mkdir(d, { recursive: true }); await writeFile(join(d, 'package.json'), JSON.stringify({ version: c.version })); } const dist = join(dir, 'node_modules', 'lark-channel-bridge', 'dist'); await mkdir(dist, { recursive: true }); await writeFile(join(dist, 'cli.js'), ''); };
    const nextManager = new UpdateManager({ paths: f.paths, install: installNext, health: async () => {} }); await nextManager.apply(f.file); expect((await nextManager.rollback()).bundleVersion).toBe('1.2.3'); expect(await readFile(profile, 'utf8')).toBe('user-data'); await stat(first.releaseDir);
  });
  it('rejects apply while a managed service is running', async () => { const f = await fixture(); await expect(new UpdateManager({ paths: f.paths, serviceRunning: () => true }).apply(f.file)).rejects.toThrow(/service is running/); });
  it('is idempotent for a healthy current bundle and recovers a stale pid lock', async () => {
    const f = await fixture(); let installs = 0; const install = async (bundle: CompatibilityBundle, dir: string) => { installs++; for (const c of Object.values(bundle.components)) { const d = join(dir, 'node_modules', c.package); await mkdir(d, { recursive: true }); await writeFile(join(d, 'package.json'), JSON.stringify({ version: c.version })); } const dist = join(dir, 'node_modules', 'lark-channel-bridge', 'dist'); await mkdir(dist, { recursive: true }); await writeFile(join(dist, 'cli.js'), ''); };
    await mkdir(f.paths.root, { recursive: true }); await writeFile(f.paths.lock, JSON.stringify({ pid: 2147483647, createdAt: 'old' })); const manager = new UpdateManager({ paths: f.paths, install, health: async () => {} }); await manager.apply(f.file); await manager.apply(f.file); expect(installs).toBe(1);
  });
  it('keeps lifecycle scripts enabled in the fixed npm install command', () => { const args = npmInstallArgs(validateBundle(manifest), 'stage'); expect(args).not.toContain('--ignore-scripts'); expect(args).toContain('@larksuite/cli@1.0.76'); });
  it('never reclaims an old lock owned by a live pid', async () => {
    const f = await fixture(); await mkdir(f.paths.root, { recursive: true }); await writeFile(f.paths.lock, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' })); const old = new Date('2000-01-01T00:00:00.000Z'); await utimes(f.paths.lock, old, old);
    await expect(withUpdateLock(f.paths, async () => undefined)).rejects.toThrow(/already running/); expect(JSON.parse(await readFile(f.paths.lock, 'utf8')).pid).toBe(process.pid);
  });
  it('records injected visibility health and rolls the pointer back when service activation partially fails', async () => {
    const f = await fixture(); const install = async (bundle: CompatibilityBundle, dir: string) => { for (const c of Object.values(bundle.components)) { const d = join(dir, 'node_modules', c.package); await mkdir(d, { recursive: true }); await writeFile(join(d, 'package.json'), JSON.stringify({ version: c.version })); } const dist = join(dir, 'node_modules', 'lark-channel-bridge', 'dist'); await mkdir(dist, { recursive: true }); await writeFile(join(dist, 'cli.js'), ''); };
    const health = { components: 'verified', protocol: 'verified', profileConfig: 'verified', larkCliConfig: 'verified', status: 'healthy' } as const;
    const manager = new UpdateManager({ paths: f.paths, install, health: async () => health, activateService: async () => { throw new Error('partial service install'); } });
    await expect(manager.apply(f.file)).rejects.toThrow('partial service install'); await expect(readFile(f.paths.current, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
