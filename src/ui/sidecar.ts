import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';
import type { UiServerHandle } from './types';

/**
 * Discovery record for a running bridge's local web-config server, written to
 * `<profileDir>/ui.json` (0600). The `ui` CLI command reads it to find the URL
 * + token of the live server and open the browser, instead of standing up its
 * own. `pid` lets the reader confirm the owning process is still alive.
 */
export interface UiSidecar {
  url: string;
  token: string;
  port: number;
  pid: number;
  startedAt: string;
}

export async function writeUiSidecar(
  uiFile: string,
  handle: Pick<UiServerHandle, 'url' | 'token' | 'port'>,
  startedAt: string,
): Promise<void> {
  const record: UiSidecar = {
    url: handle.url,
    token: handle.token,
    port: handle.port,
    pid: process.pid,
    startedAt,
  };
  await mkdir(dirname(uiFile), { recursive: true });
  await writeFileAtomic(uiFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function readUiSidecar(uiFile: string): Promise<UiSidecar | undefined> {
  try {
    const parsed = JSON.parse(await readFile(uiFile, 'utf8')) as Partial<UiSidecar>;
    if (!parsed.url || !parsed.token || typeof parsed.port !== 'number') return undefined;
    return parsed as UiSidecar;
  } catch {
    return undefined;
  }
}

export async function removeUiSidecar(uiFile: string): Promise<void> {
  await rm(uiFile, { force: true }).catch((err) =>
    log.warn('ui', 'sidecar-remove-failed', { err: String(err) }),
  );
}
