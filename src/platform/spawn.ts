import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import crossSpawn from 'cross-spawn';

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], options);
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * On Windows, npm-generated `.cmd` shims (claude.cmd, codex.cmd, ...) route
 * every spawn through `cmd.exe`. cmd.exe's argument tokenizer mangles
 * arguments that combine nested double-quotes with special characters like
 * `< > & | { }` — see CVE-2024-1874 ("BatBadBut",
 * https://flatt.tech/research/posts/batbadbut/).
 *
 * The bridge sends each prompt with a `<bridge_context>{...JSON...}</bridge_context>`
 * header as a single `-p` argument. On Windows that argument plus every flag
 * after it (`--output-format stream-json`, `--verbose`, `--append-system-prompt`,
 * ...) is silently truncated by cmd.exe. The agent then falls back to its
 * interactive default, prints a welcome banner, and exits cleanly because
 * stdin is `'ignore'`d. The bridge sees a clean exit with zero stream-json
 * events and renders an empty `(no content)` card.
 *
 * Workaround: when the binary resolves to a Windows `.cmd` shim, parse the
 * shim to find the underlying JS entry point and spawn `node <entry>` directly.
 * Node's CreateProcess argv encoding is reliable; we never go through cmd.exe.
 *
 * Returns `null` on non-Windows, when the shim can't be located, or when its
 * format isn't recognized — callers should fall back to spawning the original
 * command unchanged.
 */
export function resolveWindowsCmdShim(
  command: string,
): { command: string; prependArgs: string[] } | null {
  if (process.platform !== 'win32') return null;

  const cmdPath = isAbsolute(command) && /\.cmd$/i.test(command) && existsSync(command)
    ? command
    : findCmdShimInPath(command);
  if (!cmdPath) return null;

  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }

  // npm / pnpm / yarn shims all eventually invoke `node "...\entry.js" %*`.
  // Take the LAST quoted `.js` path — earlier matches may reference helpers
  // (e.g. node.exe lookup), and the entry point is always the last reference.
  const jsMatches = [...content.matchAll(/"([^"]+\.js)"/gi)];
  if (jsMatches.length === 0) return null;
  let jsPath = jsMatches[jsMatches.length - 1][1];

  // npm shims use the `%dp0%` placeholder (the .cmd's dirname). Expand it.
  jsPath = jsPath.replace(/%dp0%[\\/]?/gi, dirname(cmdPath) + '\\');
  if (!isAbsolute(jsPath)) {
    jsPath = join(dirname(cmdPath), jsPath);
  }
  if (!existsSync(jsPath)) return null;

  return { command: process.execPath, prependArgs: [jsPath] };
}

function findCmdShimInPath(command: string): string | null {
  if (/\.(cmd|bat|exe)$/i.test(command)) {
    return findOnPath(command);
  }
  return findOnPath(`${command}.cmd`) ?? findOnPath(`${command}.bat`);
}

function findOnPath(filename: string): string | null {
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, filename);
    if (existsSync(full)) return full;
  }
  return null;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
