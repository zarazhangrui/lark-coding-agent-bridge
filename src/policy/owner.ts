import type { RuntimeControls } from './access';
import { log } from '../core/logger';

export const OWNER_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface AppInfoSource {
  getAppInfo(opts?: {
    lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    userIdType?: 'open_id' | 'user_id' | 'union_id';
  }): Promise<{ ownerId?: string }>;
}

export interface OwnerRefreshControllerOptions {
  controls: RuntimeControls;
  source: AppInfoSource;
  appId: string;
  intervalMs?: number;
}

export interface OwnerRefreshController {
  start(): Promise<void>;
  stop(): void;
}

export async function refreshOwnerControls(
  controls: RuntimeControls,
  source: AppInfoSource,
  appId: string,
): Promise<void> {
  try {
    const ownerId = await fetchOwnerId(source);
    controls.botOwnerId = ownerId;
    controls.ownerRefreshState = 'ok';
    controls.ownerRefreshedAt = Date.now();
    delete controls.ownerRefreshError;
  } catch (err) {
    controls.ownerRefreshState = 'failed';
    controls.ownerRefreshedAt = Date.now();
    controls.ownerRefreshError = err instanceof Error ? err.message : String(err);
    log.warn('access', 'owner_refresh_failed', {
      appId,
      error: controls.ownerRefreshError,
    });
  }
}

export function createOwnerRefreshController(
  opts: OwnerRefreshControllerOptions,
): OwnerRefreshController {
  let timer: ReturnType<typeof setInterval> | undefined;
  const intervalMs = opts.intervalMs ?? OWNER_REFRESH_INTERVAL_MS;

  return {
    async start(): Promise<void> {
      await refreshOwnerControls(opts.controls, opts.source, opts.appId);
      timer = setInterval(() => {
        void refreshOwnerControls(opts.controls, opts.source, opts.appId);
      }, intervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

async function fetchOwnerId(source: AppInfoSource): Promise<string> {
  const { ownerId } = await source.getAppInfo({
    lang: 'zh_cn',
    userIdType: 'open_id',
  });
  if (!ownerId) throw new Error('application owner missing from API response');
  return ownerId;
}
