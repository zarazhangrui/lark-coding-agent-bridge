import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the bundled `lark-cli` guard shim directory.
 *
 * The built entry lives at `<pkg>/dist/cli.js` (this source is bundled into it);
 * the shim ships at `<pkg>/bin/shims/lark-cli` (see package.json `files`). We
 * resolve it relative to the running bundle so it works wherever the package is
 * installed. NOTE: the `..` hops are relative to `dist/cli.js`, not this source.
 */
export function larkCliGuardDir(): string {
  return fileURLToPath(new URL('../bin/shims/', import.meta.url));
}

/**
 * Prepend the guard shim dir to PATH so a spawned agent's `lark-cli` resolves to
 * our wrapper. The wrapper forces `--as bot` for `im` message sends (TARS may
 * not post as the user) while passing docs / config / auth through untouched.
 *
 * Applied only to the agent's spawn env — the daemon's own lark-cli calls
 * (preflight bind / identity policy) keep the original PATH.
 */
export function withLarkCliGuard(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = larkCliGuardDir();
  const current = process.env.PATH ?? '';
  return { ...overrides, PATH: current ? `${dir}${delimiter}${current}` : dir };
}
