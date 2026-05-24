import { homedir } from 'node:os';
import { join } from 'node:path';

let appDir = join(homedir(), '.lark-channel');

export const paths = {
  get appDir(): string {
    return appDir;
  },
  get cacheDir(): string {
    return appDir;
  },
  get configFile(): string {
    return join(appDir, 'config.json');
  },
  get sessionsFile(): string {
    return join(appDir, 'sessions.json');
  },
  get workspacesFile(): string {
    return join(appDir, 'workspaces.json');
  },
  get processesFile(): string {
    return join(appDir, 'processes.json');
  },
  get secretsFile(): string {
    return join(appDir, 'secrets.enc');
  },
  get keystoreSaltFile(): string {
    return join(appDir, '.keystore.salt');
  },
  /**
   * Thin shell wrapper that lark-cli (and other openclaw-exec-protocol
   * consumers) invoke to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
  get secretsGetterScript(): string {
    return join(appDir, 'secrets-getter');
  },
  get mediaDir(): string {
    return join(appDir, 'media');
  },
};

export function configurePaths(dir: string): void {
  appDir = dir;
}

/**
 * Pre-0.1.11 paths (XDG-style). Kept here only so the `migrate` command
 * can detect and move data out of the old location. Don't reference these
 * anywhere in the runtime.
 */
export const legacyPaths = {
  appDir: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'lark-channel-bridge',
  ),
  cacheDir: join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'lark-channel-bridge',
  ),
};
