import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';

/**
 * A single machine-wide lock for the supervisor process, so a second
 * `run`/`start` detects the running control plane instead of launching a
 * duplicate. Separate from the per-profile/app runtime locks (those still gate
 * individual channels inside the supervisor).
 */
export interface HostLock {
  release(): Promise<void>;
}

/**
 * Acquire the host lock. Returns a handle to hold for the process lifetime, or
 * `null` if another supervisor already holds it (→ caller should print the
 * running console URL and exit).
 */
export async function acquireHostLock(target: string): Promise<HostLock | null> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '', { flag: 'a', mode: 0o600 }).catch(() => {});
  try {
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
    return { release: () => release() };
  } catch {
    return null; // already held by a running supervisor
  }
}
