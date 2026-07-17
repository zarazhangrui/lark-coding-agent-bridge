import { randomBytes } from 'node:crypto';
import { registerApp } from '@larksuite/channel';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig } from '../config/profile-store';
import type { TenantBrand } from '../config/schema';
import type { AgentKind } from '../config/profile-schema';
import { validateAppCredentials } from '../utils/feishu-auth';
import { log } from '../core/logger';
import { HttpError } from './http';
import { writeNewProfile } from './onboard';

/**
 * Turn an arbitrary app/bot name into a valid profile name (or '' if none).
 * Keeps Unicode letters (so a Chinese bot name like 尼莫 becomes the profile
 * name directly); only strips characters unsafe as a path segment — matching
 * what `normalizeProfileName` accepts.
 */
function sanitizeProfileName(name: string): string {
  return (
    name
      .trim()
      // Strip only chars unsafe as a path segment (matches normalizeProfileName);
      // keep Unicode letters so a Chinese bot name like 尼莫 stays as-is.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\s/\\:*?"<>|]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40)
  );
}

function uniqueProfileName(base: string, existing: Set<string>): string {
  const b = base || 'bot';
  if (!existing.has(b)) return b;
  let i = 2;
  while (existing.has(`${b}-${i}`)) i++;
  return `${b}-${i}`;
}

/**
 * QR app-creation session. Mirrors the terminal `runRegistrationWizard`:
 * `registerApp` yields a QR URL to scan and resolves with fresh app
 * credentials once the user finishes creating the app in Feishu. Two phases so
 * the agent/profile choice is applied at scan time, not baked into the QR:
 *   start  → shows the QR (poll {@link qrStatus} for 'scanned')
 *   finish → writes the profile from the created app creds + chosen agent/profile
 * The App Secret lives only in the session (localhost, short TTL) between the
 * two, and is cleared right after the profile is written.
 */
interface QrSession {
  status: 'pending' | 'scanned' | 'done' | 'error';
  qrUrl: string;
  expireIn: number;
  app?: { appId: string; appSecret: string; tenant: TenantBrand };
  /** App/bot name from the created app (for the confirm-step prefill). */
  botName?: string;
  /** Sanitized + de-duped profile name suggestion derived from botName. */
  suggestedProfile?: string;
  profile?: string;
  error?: string;
  createdAt: number;
}

const sessions = new Map<string, QrSession>();
const SESSION_TTL_MS = 20 * 60 * 1000;

function prune(now: number): void {
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * Begin a QR registration. Resolves once the QR URL is ready (so the client can
 * render it); the app is created out-of-band when the user scans — track via
 * {@link qrStatus}, then call {@link finishQrRegistration}.
 */
export async function startQrRegistration(rootDir?: string): Promise<{
  sessionId: string;
  qrUrl: string;
  expireIn: number;
}> {
  const id = randomBytes(9).toString('hex');
  const session: QrSession = { status: 'pending', qrUrl: '', expireIn: 0, createdAt: Date.now() };
  sessions.set(id, session);
  prune(session.createdAt);

  await new Promise<void>((resolve, reject) => {
    let readied = false;
    registerApp({
      source: 'lark-channel-bridge',
      onQRCodeReady: (info) => {
        session.qrUrl = info.url;
        session.expireIn = info.expireIn;
        readied = true;
        resolve();
      },
    })
      .then(async (result) => {
        const tenant: TenantBrand = result.user_info?.tenant_brand ?? 'feishu';
        session.app = { appId: result.client_id, appSecret: result.client_secret, tenant };
        // Fetch the app/bot name and derive a profile-name suggestion.
        const info = await validateAppCredentials(result.client_id, result.client_secret, tenant).catch(
          () => undefined,
        );
        session.botName = info?.botName;
        const existing = new Set(
          Object.keys((await loadRootConfig(resolveAppPaths({ rootDir }).configFile))?.profiles ?? {}),
        );
        session.suggestedProfile = uniqueProfileName(sanitizeProfileName(info?.botName ?? ''), existing);
        session.status = 'scanned';
        log.info('ui', 'qr-register-scanned', { appId: result.client_id, botName: info?.botName });
      })
      .catch((err) => {
        session.status = 'error';
        session.error = err instanceof Error ? err.message : String(err);
        // Failed before the QR was even shown → fail the start call too.
        if (!readied) reject(new HttpError(502, `扫码创建启动失败：${session.error}`));
      });
  });

  return { sessionId: id, qrUrl: session.qrUrl, expireIn: session.expireIn };
}

export function qrStatus(sessionId: string): {
  status: QrSession['status'];
  profile?: string;
  botName?: string;
  suggestedProfile?: string;
  error?: string;
} {
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, 'qr session not found or expired');
  return {
    status: s.status,
    profile: s.profile,
    botName: s.botName,
    suggestedProfile: s.suggestedProfile,
    error: s.error,
  };
}

/** Write the profile once the app is created (status 'scanned'). Idempotent. */
export async function finishQrRegistration(
  body: unknown,
  rootDir?: string,
): Promise<{ profile: string }> {
  const fv = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const sessionId = String(fv.sessionId ?? '');
  const s = sessions.get(sessionId);
  if (!s) throw new HttpError(404, 'qr session not found or expired');
  if (s.status === 'done' && s.profile) return { profile: s.profile };
  if (s.status === 'error') throw new HttpError(400, s.error ?? '扫码创建失败');
  if (!s.app) throw new HttpError(409, '尚未完成扫码');

  const agentKind: AgentKind = fv.agentKind === 'codex' ? 'codex' : 'claude';
  const profile = String(fv.profile ?? '').trim() || s.suggestedProfile || agentKind;
  const created = await writeNewProfile(
    { profile, agentKind, appId: s.app.appId, appSecret: s.app.appSecret, tenant: s.app.tenant },
    rootDir,
  );
  s.status = 'done';
  s.profile = created.profile;
  s.app = undefined; // drop the secret from memory once persisted
  return { profile: created.profile };
}
