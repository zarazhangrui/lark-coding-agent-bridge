import { resolveAppPaths } from '../config/app-paths';
import { buildLarkChannelEnv } from '../agent/lark-channel-env';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { log } from '../core/logger';
import { t } from '../i18n';

/**
 * Pre-flight for the in-meeting agent: does the **app (bot) identity** actually
 * hold the scopes it needs, and is the beta enabled?
 *
 * Why shell out to lark-cli for a diagnostic when the runtime path uses the
 * oapi client directly: lark-cli enriches Feishu's bare `99991672` into
 * `missing_scopes` plus a ready-made `console_url` (the scope-apply page with
 * clientID and scopes pre-filled). That URL is exactly what the console needs
 * to offer a one-click "grant it" button, and it must be passed through
 * verbatim — never reconstructed — so we harvest it rather than building one.
 *
 * The probe itself is a read-only call (`vc +meeting-list-active`) chosen
 * because it exercises the same scope family as joining without side effects.
 */

/** Early-bird group to request the allowlisted beta (error 20017). */
export const MEETING_BETA_CHAT_URL =
  'https://go.larkoffice.com/join-chat/2f4nb0e1-fe00-4f67-bed7-25beaf533fbd';

/**
 * App-identity scopes the feature needs. They are granted independently, and
 * hitting one does not imply the others — joining works with just
 * `bot.join:write`, but posting into the meeting then fails until
 * `message:write` is granted too (observed as an HTTP 400).
 */
export const MEETING_REQUIRED_SCOPES = [
  { scope: 'vc:meeting.bot.join:write', purpose: '让 bot 入会 / 离会' },
  { scope: 'vc:meeting.message:write', purpose: '在会中发消息（回答会发不出去）' },
  { scope: 'vc:meeting.meetingevent:read', purpose: '读会中事件（字幕/弹幕/进退会）' },
];

/** Events the app must subscribe to (长连接 mode) for push to arrive. */
export const MEETING_REQUIRED_EVENTS = [
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
];

export type MeetingPreflightStatus =
  | 'ok'
  /** App-level scope missing — fixable via `consoleUrl`. */
  | 'scope-missing'
  /** Allowlisted beta not enabled for this app (20017). */
  | 'not-in-beta'
  /** Probe could not run (lark-cli absent, not bound, network). */
  | 'unknown';

export interface MeetingPreflight {
  status: MeetingPreflightStatus;
  message: string;
  /** Scopes the app is missing, verbatim from the API. */
  missingScopes: string[];
  /**
   * Feishu scope-apply URL, verbatim from the API response. Opaque — render as
   * link/QR only; never edit, re-encode or rebuild it.
   */
  consoleUrl?: string;
  /** Events that must be subscribed for push (cannot be queried via API). */
  requiredEvents: string[];
  /**
   * All app scopes the feature needs, with what each unlocks. The probe can
   * only report the scope it happened to trip on, so the console shows the full
   * set — granting them together avoids a second round-trip.
   */
  requiredScopes: { scope: string; purpose: string }[];
  /** Beta sign-up link, present when `status === 'not-in-beta'`. */
  betaChatUrl?: string;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type PreflightExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;

const defaultExec: PreflightExec = (args, env) =>
  new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawnProcess('lark-cli', args, {
      env: mergeProcessEnv(process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(err) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return undefined;
    }
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Classify a lark-cli VC probe response into an actionable diagnosis.
 * Exported for tests — the parsing is the part worth pinning down.
 */
export function classifyPreflight(payload: unknown): MeetingPreflight {
  const base = {
    missingScopes: [] as string[],
    requiredEvents: MEETING_REQUIRED_EVENTS,
    requiredScopes: MEETING_REQUIRED_SCOPES,
  };
  if (!isRecord(payload)) {
    return { ...base, status: 'unknown', message: t('meeting.preflight.unparseable') };
  }
  if (payload.ok === true) {
    return { ...base, status: 'ok', message: t('meeting.preflight.ok') };
  }
  const err = isRecord(payload.error) ? payload.error : {};
  const code = typeof err.code === 'number' ? err.code : undefined;
  const subtype = typeof err.subtype === 'string' ? err.subtype : '';
  const message = typeof err.message === 'string' ? err.message : t('meeting.preflight.checkFailed');
  const consoleUrl = typeof err.console_url === 'string' ? err.console_url : undefined;
  const missingScopes = strings(err.missing_scopes);

  // 20017 / ErrNotInGray — the capability itself isn't open for this app yet,
  // so no amount of scope granting helps.
  if (code === 20017 || /ErrNotInGray/i.test(message) || /not.?in.?gray/i.test(subtype)) {
    return {
      ...base,
      status: 'not-in-beta',
      message: t('meeting.preflight.notInBeta'),
      betaChatUrl: MEETING_BETA_CHAT_URL,
    };
  }
  if (subtype === 'app_scope_not_applied' || code === 99991672 || missingScopes.length > 0) {
    return {
      ...base,
      status: 'scope-missing',
      message,
      missingScopes: missingScopes.length ? missingScopes : ['vc:meeting.bot.join:write'],
      ...(consoleUrl ? { consoleUrl } : {}),
    };
  }
  return {
    ...base,
    status: 'unknown',
    message,
    ...(consoleUrl ? { consoleUrl } : {}),
  };
}

export interface MeetingPreflightInput {
  profile: string;
  rootDir?: string;
  /** Any user open_id; the probe needs one but never acts on it. */
  probeUserId?: string;
}

/** Run the read-only probe and classify the result. */
export async function checkMeetingPreflight(
  input: MeetingPreflightInput,
  exec: PreflightExec = defaultExec,
): Promise<MeetingPreflight> {
  const appPaths = resolveAppPaths({ rootDir: input.rootDir, profile: input.profile });
  const env = buildLarkChannelEnv({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: appPaths.configFile,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  });
  const args = ['vc', '+meeting-list-active', '--as', 'bot', '--json'];
  if (input.probeUserId) args.push('--user-id', input.probeUserId);

  const r = await exec(args, env);
  const payload = parseJson(r.stdout) ?? parseJson(r.stderr);
  if (payload === undefined) {
    return {
      status: 'unknown',
      message: r.stderr.trim().split('\n')[0] ?? t('meeting.preflight.noResult'),
      missingScopes: [],
      requiredEvents: MEETING_REQUIRED_EVENTS,
      requiredScopes: MEETING_REQUIRED_SCOPES,
    };
  }
  const result = classifyPreflight(payload);
  log.info('meeting', 'preflight', { status: result.status, missing: result.missingScopes.length });
  return result;
}
