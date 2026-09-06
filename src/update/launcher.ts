import { lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveUpdatePaths } from './paths';
import type { ReleasePointer } from './manager';
import { assertSupportedProtocolRevision, validateBundle } from './manifest';
export async function resolveValidatedManagedLauncher(root?: string): Promise<string | undefined> {
  const paths = resolveUpdatePaths(root);
  let pointer: ReleasePointer;
  try { pointer = JSON.parse(await readFile(paths.current, 'utf8')) as ReleasePointer; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  validateBundle({ schema: 'lark-channel-bundle.v1', bundleVersion: pointer.bundleVersion, protocolRevision: pointer.protocolRevision, components: pointer.components });
  assertSupportedProtocolRevision(pointer.protocolRevision);
  if (typeof pointer.verifiedAt !== 'string' || !Number.isFinite(Date.parse(pointer.verifiedAt))) throw new Error('invalid managed pointer timestamp');
  const releases = await realpath(paths.releases); if ((await lstat(pointer.releaseDir)).isSymbolicLink()) throw new Error('managed release is a link'); const release = await realpath(pointer.releaseDir); assertContained(releases, release);
  for (const component of Object.values(pointer.components)) { const dir = join(release, 'node_modules', component.package); if ((await lstat(dir)).isSymbolicLink()) throw new Error('managed package is a link'); assertContained(release, await realpath(dir)); const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version?: string }; if (pkg.version !== component.version) throw new Error(`managed version mismatch: ${component.package}`); }
  const bin = join(release, 'node_modules', '.bin'); if ((await lstat(bin)).isSymbolicLink()) throw new Error('managed bin is a link'); assertContained(release, await realpath(bin));
  const entry = join(release, 'node_modules', 'lark-channel-bridge', 'dist', 'cli.js'); if ((await lstat(entry)).isSymbolicLink()) throw new Error('managed bridge entry is a link'); assertContained(release, await realpath(entry));
  const launcher = join(paths.root, 'launcher.mjs'); if ((await lstat(launcher)).isSymbolicLink()) throw new Error('managed launcher is a link'); assertContained(await realpath(paths.root), await realpath(launcher)); return launcher;
}
function assertContained(parent: string, child: string): void { const rel = relative(parent, child); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('managed path escaped runtime root'); }
export async function runManagedLauncher(args = process.argv.slice(2), root?: string): Promise<number> {
  await resolveValidatedManagedLauncher(root);
  const pointer = JSON.parse(await readFile(resolveUpdatePaths(root).current, 'utf8')) as ReleasePointer;
  const binDir = join(pointer.releaseDir, 'node_modules', '.bin');
  const entry = join(pointer.releaseDir, 'node_modules', 'lark-channel-bridge', 'dist', 'cli.js');
  const codex = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  return new Promise((resolveExit, reject) => { const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`, LARK_CHANNEL_MANAGED_CODEX_BIN: codex, LARK_CHANNEL_BRIDGE_ENTRY: process.argv[1], LARK_CHANNEL_MANAGED_LAUNCH: '1' } }); child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 1)); });
}
