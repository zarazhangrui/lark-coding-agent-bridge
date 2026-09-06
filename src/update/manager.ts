import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import crossSpawn from 'cross-spawn';
import {
  assertSupportedProtocolRevision,
  safeBundleDirName,
  SUPPORTED_PROTOCOL_REVISIONS,
  validateBundle,
  type CompatibilityBundle,
} from './manifest';
import { resolveUpdatePaths, type UpdatePaths } from './paths';

export interface HealthReport { components: 'verified'; protocol: 'verified'; profileConfig: 'verified' | 'skipped'; larkCliConfig: 'verified' | 'skipped'; status: 'healthy' | 'degraded' }
export interface HealthContext { profile: string; rootConfigFile: string; larkCliConfigDir: string; profileExists: boolean; codexHome?: string }
export interface ReleasePointer { bundleVersion: string; releaseDir: string; components: CompatibilityBundle['components']; protocolRevision: string; verifiedAt: string; health?: HealthReport }
export interface UpdateManagerDeps {
  paths?: UpdatePaths;
  fetchJson?: (url: string) => Promise<unknown>;
  install?: (bundle: CompatibilityBundle, stagingDir: string) => Promise<void>;
  health?: (bundle: CompatibilityBundle, releaseDir: string) => Promise<HealthReport | void>;
  healthContext?: HealthContext;
  serviceRunning?: () => boolean | Promise<boolean>;
  resolveIntegrity?: (packageName: string, version: string) => Promise<string>;
  activateService?: (launcherPath: string) => Promise<void>;
}

export class UpdateManager {
  private readonly paths: UpdatePaths;
  constructor(private readonly deps: UpdateManagerDeps = {}) { this.paths = deps.paths ?? resolveUpdatePaths(); }
  async loadManifest(source: string): Promise<CompatibilityBundle> {
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('update manifest URL must use HTTPS');
      const raw = this.deps.fetchJson ? await this.deps.fetchJson(source) : await fetch(source).then(async (r) => { if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`); return r.json(); });
      return validateBundle(raw);
    }
    return validateBundle(JSON.parse(await readFile(resolve(source), 'utf8')));
  }
  async check(source: string): Promise<{ bundle: CompatibilityBundle; active?: ReleasePointer }> { return { bundle: await this.loadManifest(source), active: await this.readPointer(this.paths.current) }; }
  async status(): Promise<{ active?: ReleasePointer; previous?: ReleasePointer; activeHealthy: boolean; previousHealthy: boolean; diagnostics: string[] }> {
    const diagnostics: string[] = []; const active = await this.readPointer(this.paths.current).catch((e) => { diagnostics.push(`current pointer invalid: ${errorText(e)}`); return undefined; }); const previous = await this.readPointer(this.paths.previous).catch((e) => { diagnostics.push(`previous pointer invalid: ${errorText(e)}`); return undefined; });
    return { active, previous, activeHealthy: await pointerExists(active), previousHealthy: await pointerExists(previous), diagnostics };
  }
  async apply(source: string): Promise<ReleasePointer> {
    return withUpdateLock(this.paths, async () => {
      if (await this.deps.serviceRunning?.()) throw new Error('managed service is running; stop it before update apply');
      const bundle = await this.loadManifest(source); const name = safeBundleDirName(bundle.bundleVersion);
      const current = await this.readPointer(this.paths.current);
      if (current?.bundleVersion === bundle.bundleVersion) { await this.validatePointer(current); const health = await this.checkHealth(bundle, current.releaseDir); const refreshed = { ...current, health }; await atomicJson(this.paths.current, refreshed); const launcher = await materializeLauncher(this.paths); await this.deps.activateService?.(launcher); return refreshed; }
      await mkdir(this.paths.staging, { recursive: true }); await mkdir(this.paths.releases, { recursive: true });
      const staging = join(this.paths.staging, `${name}-${process.pid}-${Date.now()}`); const release = join(this.paths.releases, name);
      this.assertWithin(this.paths.staging, staging); this.assertWithin(this.paths.releases, release); await mkdir(staging, { recursive: true });
      try {
        await (this.deps.install ?? ((b, d) => defaultInstall(b, d, this.deps.resolveIntegrity)))(bundle, staging);
        await this.checkHealth(bundle, staging);
        try { await stat(release); try { await this.checkHealth(bundle, release); await rm(staging, { recursive: true, force: true }); } catch { await rename(release, `${release}.quarantine-${Date.now()}`); await rename(staging, release); } } catch { await rename(staging, release); }
        const health = await this.checkHealth(bundle, release); const pointer = pointerFor(bundle, release, health); const old = await this.readPointer(this.paths.current);
        if (old) { await this.validatePointer(old); const oldBundle = validateBundle({ schema: 'lark-channel-bundle.v1', bundleVersion: old.bundleVersion, protocolRevision: old.protocolRevision, components: old.components }); await this.checkHealth(oldBundle, old.releaseDir); await atomicJson(this.paths.previous, old); }
        await atomicJson(this.paths.current, pointer);
        try { await this.checkHealth(bundle, release); const launcher = await materializeLauncher(this.paths); await this.deps.activateService?.(launcher); } catch (error) { if (old) await atomicJson(this.paths.current, old); else await rm(this.paths.current, { force: true }); throw error; }
        await atomicJson(this.paths.state, { status: 'active', ...pointer }); return pointer;
      } catch (error) { await rm(staging, { recursive: true, force: true }); await atomicJson(this.paths.state, { status: 'failed', bundleVersion: bundle.bundleVersion, error: error instanceof Error ? error.message : String(error) }); throw error; }
    });
  }
  async rollback(): Promise<ReleasePointer> {
    if (await this.deps.serviceRunning?.()) throw new Error('managed service is running; stop it before rollback');
    return withUpdateLock(this.paths, async () => {
      if (await this.deps.serviceRunning?.()) throw new Error('managed service is running; stop it before rollback');
      const previous = await this.readPointer(this.paths.previous); if (!previous) throw new Error('no verified previous release'); await this.validatePointer(previous);
      const bundle = validateBundle({ schema: 'lark-channel-bundle.v1', bundleVersion: previous.bundleVersion, protocolRevision: previous.protocolRevision, components: previous.components });
      const health = await this.checkHealth(bundle, previous.releaseDir); const verified = { ...previous, health };
      const current = await this.readPointer(this.paths.current); await atomicJson(this.paths.current, verified); if (current) await atomicJson(this.paths.previous, current); await atomicJson(this.paths.state, { status: 'rolled-back', ...verified }); return verified;
    });
  }
  private async readPointer(path: string): Promise<ReleasePointer | undefined> { try { const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<ReleasePointer>; if (typeof raw.releaseDir !== 'string' || typeof raw.verifiedAt !== 'string') throw new Error('malformed release pointer'); validateBundle({ schema: 'lark-channel-bundle.v1', bundleVersion: raw.bundleVersion, protocolRevision: raw.protocolRevision, components: raw.components }); return raw as ReleasePointer; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
  private assertWithin(parent: string, child: string): void { const rel = resolve(child).slice(resolve(parent).length); if (!rel.startsWith('\\') && !rel.startsWith('/')) throw new Error('update path escaped runtime root'); }
  private async validatePointer(pointer: ReleasePointer): Promise<void> { validateBundle({ schema: 'lark-channel-bundle.v1', bundleVersion: pointer.bundleVersion, protocolRevision: pointer.protocolRevision, components: pointer.components }); this.assertWithin(this.paths.releases, pointer.releaseDir); const info = await lstat(pointer.releaseDir); if (info.isSymbolicLink()) throw new Error('release directory must not be a link'); const actual = await realpath(pointer.releaseDir); const releases = await realpath(this.paths.releases); this.assertWithin(releases, actual); for (const component of Object.values(pointer.components)) { const packageDir = join(actual, 'node_modules', component.package); if ((await lstat(packageDir)).isSymbolicLink()) throw new Error('package directory must not be a link'); this.assertWithin(actual, await realpath(packageDir)); } const entry = join(actual, 'node_modules', FIXED_BRIDGE, 'dist', 'cli.js'); this.assertWithin(actual, await realpath(entry)); }
  private async checkHealth(bundle: CompatibilityBundle, releaseDir: string): Promise<HealthReport> { const report = await (this.deps.health ? this.deps.health(bundle, releaseDir) : defaultHealth(bundle, releaseDir, this.deps.healthContext)); return report ?? { components: 'verified', protocol: 'verified', profileConfig: 'skipped', larkCliConfig: 'skipped', status: 'degraded' }; }
}
function pointerFor(bundle: CompatibilityBundle, releaseDir: string, health: HealthReport): ReleasePointer { return { bundleVersion: bundle.bundleVersion, releaseDir, components: bundle.components, protocolRevision: bundle.protocolRevision, verifiedAt: new Date().toISOString(), health }; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`); await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); for (let attempt = 0; ; attempt++) { try { await rename(tmp, path); return; } catch (error) { if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * 2 ** attempt)); } } }
export async function defaultInstall(bundle: CompatibilityBundle, dir: string, resolver: UpdateManagerDeps['resolveIntegrity'] = defaultIntegrity): Promise<void> {
  for (const component of Object.values(bundle.components)) { const actual = await resolver!(component.package, component.version); if (actual !== component.integrity) throw new Error(`npm integrity mismatch: ${component.package}`); }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmInstallArgs(bundle, dir));
  const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')) as { lockfileVersion?: number; packages?: Record<string, { integrity?: string }> };
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('npm install did not produce package-lock v3');
  for (const component of Object.values(bundle.components)) { const installed = lock.packages[`node_modules/${component.package}`]; if (installed?.integrity !== component.integrity) throw new Error(`installed integrity mismatch: ${component.package}`); }
}
export function npmInstallArgs(bundle: CompatibilityBundle, dir: string): string[] { return ['install', '--no-audit', '--no-fund', '--prefix', dir, '--save-exact', ...Object.values(bundle.components).map((c) => `${c.package}@${c.version}`)]; }
async function defaultHealth(bundle: CompatibilityBundle, dir: string, context?: HealthContext): Promise<HealthReport> {
  for (const component of Object.values(bundle.components)) { const pkg = JSON.parse(await readFile(join(dir, 'node_modules', component.package, 'package.json'), 'utf8')) as { version?: string }; if (pkg.version !== component.version) throw new Error(`installed version mismatch: ${component.package}`); }
  const bin = process.platform === 'win32' ? join(dir, 'node_modules', '.bin') : join(dir, 'node_modules', '.bin');
  const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await run(codex, ['app-server', '--help']);
  assertSupportedProtocolRevision(bundle.protocolRevision);
  await appServerHealth(codex, context?.codexHome);
  await run(join(bin, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli'), ['--version']);
  await run(join(bin, process.platform === 'win32' ? 'lark-channel-bridge.cmd' : 'lark-channel-bridge'), ['--version']);
  if (!context?.profileExists) return { components: 'verified', protocol: 'verified', profileConfig: 'skipped', larkCliConfig: 'skipped', status: 'degraded' };
  const root = JSON.parse(await readFile(context.rootConfigFile, 'utf8')) as { profiles?: Record<string, unknown> }; if (!root.profiles?.[context.profile]) throw new Error(`managed Bridge profile config is not visible: ${context.profile}`);
  await run(join(bin, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli'), ['config', 'show'], { LARKSUITE_CLI_CONFIG_DIR: context.larkCliConfigDir });
  return { components: 'verified', protocol: 'verified', profileConfig: 'verified', larkCliConfig: 'verified', status: 'healthy' };
}
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> { return new Promise((resolveRun, reject) => { const child = crossSpawn(command, args, { stdio: 'ignore', shell: false, env: env ? { ...process.env, ...env } : process.env }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`))); }); }
async function defaultIntegrity(packageName: string, version: string): Promise<string> { let output = ''; await new Promise<void>((resolveRun, reject) => { const child = crossSpawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', `${packageName}@${version}`, 'dist.integrity', '--json'], { shell: false }); child.stdout?.on('data', (c) => { output += c; }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error('npm integrity lookup failed'))); }); return JSON.parse(output) as string; }
async function appServerHealth(codex: string, codexHome?: string): Promise<void> { await new Promise<void>((resolveHealth, reject) => { const child = crossSpawn(codex, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env }); const stdin = child.stdin!; const stdout = child.stdout!; let buffer = '', initialized = false; const timer = setTimeout(() => { child.kill(); reject(new Error('Codex App Server protocol health timed out')); }, 5000); child.once('error', reject); stdout.on('data', (chunk) => { buffer += chunk; for (;;) { const nl = buffer.indexOf('\n'); if (nl < 0) break; const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); let msg: { id?: number; result?: unknown; error?: unknown }; try { msg = JSON.parse(line); } catch { continue; } if (msg.error) { clearTimeout(timer); child.kill(); reject(new Error('Codex App Server protocol health failed')); return; } if (msg.id === 1 && !initialized) { initialized = true; stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [], forceReload: false } })}\n`); } else if (msg.id === 2) { clearTimeout(timer); child.kill(); resolveHealth(); return; } } }); stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lark-channel-updater', version: '1' }, capabilities: null } })}\n`); }); }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export async function withUpdateLock<T>(paths: UpdatePaths, work: () => Promise<T>): Promise<T> { await mkdir(paths.root, { recursive: true }); let lock; try { lock = await open(paths.lock, 'wx'); } catch { const info = await stat(paths.lock).catch(() => undefined); const meta = await readFile(paths.lock, 'utf8').then(JSON.parse).catch(() => undefined) as { pid?: number; createdAt?: string } | undefined; const age = Date.now() - Math.max(info?.mtimeMs ?? 0, meta?.createdAt ? Date.parse(meta.createdAt) : 0); const stale = age > 10 * 60_000; const validPid = Number.isInteger(meta?.pid) && (meta?.pid ?? 0) > 0; if ((validPid && !pidAlive(meta!.pid!)) || (!validPid && stale)) { await rm(paths.lock, { force: true }); lock = await open(paths.lock, 'wx'); } else throw new Error('another update or service start is already running'); } await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); try { return await work(); } finally { await lock.close(); await rm(paths.lock, { force: true }); } }
const FIXED_BRIDGE = 'lark-channel-bridge';
async function materializeLauncher(paths: UpdatePaths): Promise<string> { const path = join(paths.root, 'launcher.mjs'); const source = `import{readFile,realpath,lstat}from'node:fs/promises';import{join,delimiter,relative,isAbsolute}from'node:path';import{spawn}from'node:child_process';const root=${JSON.stringify(paths.root)},releases=join(root,'releases'),inside=(a,b)=>{const r=relative(a,b);return r!==''&&!r.startsWith('..')&&!isAbsolute(r)},safe=async p=>{if((await lstat(p)).isSymbolicLink())throw Error('linked managed path');return realpath(p)};const p=JSON.parse(await readFile(join(root,'current.json'),'utf8')),sem=/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?$/,integrity=/^sha512-[A-Za-z0-9+/]+={0,2}$/;if(!sem.test(p?.bundleVersion)||typeof p?.verifiedAt!=='string'||!Number.isFinite(Date.parse(p.verifiedAt))||!${JSON.stringify(SUPPORTED_PROTOCOL_REVISIONS)}.includes(p?.protocolRevision)||p?.components?.bridge?.package!=='lark-channel-bridge'||p?.components?.codex?.package!=='@openai/codex'||p?.components?.larkCli?.package!=='@larksuite/cli'||Object.values(p.components).some(c=>!sem.test(c.version)||!integrity.test(c.integrity)))throw Error('invalid release pointer');const rr=await realpath(releases),rd=await safe(p.releaseDir);if(!inside(rr,rd))throw Error('unsafe release pointer');for(const c of Object.values(p.components)){const d=await safe(join(rd,'node_modules',c.package));if(!inside(rd,d))throw Error('unsafe package');const j=JSON.parse(await readFile(join(d,'package.json'),'utf8'));if(j.version!==c.version)throw Error('managed version mismatch')}const bin=await safe(join(rd,'node_modules','.bin')),entry=await safe(join(rd,'node_modules','lark-channel-bridge','dist','cli.js'));if(!inside(rd,bin)||!inside(rd,entry))throw Error('unsafe managed entry');const codex=join(bin,process.platform==='win32'?'codex.cmd':'codex');const c=spawn(process.execPath,[entry,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,PATH:bin+delimiter+(process.env.PATH||''),LARK_CHANNEL_MANAGED_CODEX_BIN:codex,LARK_CHANNEL_BRIDGE_ENTRY:process.argv[1],LARK_CHANNEL_MANAGED_LAUNCH:'1'}});c.on('exit',x=>process.exit(x??1));`; const tmp = join(paths.root, `.launcher.${process.pid}.${Date.now()}.tmp`); await writeFile(tmp, source, { mode: 0o700 }); for (let attempt = 0; ; attempt++) { try { await rename(tmp, path); break; } catch (error) { if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * 2 ** attempt)); } } return path; }
async function pointerExists(pointer: ReleasePointer | undefined): Promise<boolean> { if (!pointer) return false; try { await stat(join(pointer.releaseDir, 'node_modules', pointer.components.bridge.package, 'package.json')); return true; } catch { return false; } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
