import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetry } from './telemetry';

export interface LoggerOptions {
  logsDir?: string;
  retentionDays: number;
  now: () => Date;
}

const DEFAULT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 30) || 30,
);

let loggerOptions: LoggerOptions = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  now: () => new Date(),
};

/**
 * Stdout is for humans tailing the terminal. Only these noisy-but-meaningful
 * events bubble up; everything else lives in the JSON log file.
 *
 * Add `phase.event` keys here to surface a new line, but keep the list
 * short — every entry adds noise.
 */
const STDOUT_INFO_ALLOWLIST = new Set<string>([
  'ws.connected',
  'ws.reconnecting',
  'ws.reconnected',
  'intake.enter',
  'intake.command',
  'run.started',
  'run.completed',
  'run.failed',
  'cot.created',
  'cot.completed',
  'outbound.sent',
  'outbound.markdown-stream-fallback',
  'card.final',
]);

/**
 * Structured logger.
 *
 * Two destinations on every call:
 *  1. JSON line into the active profile logs directory — the durable
 *     record `/doctor` greps over.
 *  2. Compact human-readable line on stdout/stderr — for live tailing in dev.
 *
 * Per-message context (traceId, chatId, msgId) is propagated automatically
 * via AsyncLocalStorage; call `withTrace()` once at the entry point and any
 * downstream `log.*` calls pick up the same fields.
 */

export interface LogContext {
  traceId?: string;
  chatId?: string;
  msgId?: string;
}

const als = new AsyncLocalStorage<LogContext>();

let stream: WriteStream | null = null;
let currentDate = '';

function todayKey(): string {
  return formatLocalDateKey(loggerOptions.now());
}

function logsDir(): string | undefined {
  return loggerOptions.logsDir;
}

function logFileName(dateKey: string): string {
  return `bridge-${dateKey}.jsonl`;
}

function getStream(): WriteStream | null {
  const dir = logsDir();
  if (!dir) return null;
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
  }
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, logFileName(today)), { flags: 'a' });
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}

type Level = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * Field keys we own — callers MUST NOT clobber these via the `fields` arg.
 * If they try (e.g. `log.fail('comment', err, { phase: 'postCommentReply' })`),
 * the caller-supplied value is renamed to `_<key>` so the info isn't lost
 * but `grep '"phase":"comment"'` still finds the entry.
 */
const RESERVED_KEYS = new Set([
  'ts',
  'level',
  'phase',
  'event',
  'traceId',
  'chatId',
  'msgId',
]);

const TELEMETRY_ENVELOPE_KEYS = new Set([
  'ts',
  'level',
  'phase',
  'event',
  'traceId',
  'chatId',
  'msgId',
]);

const RAW_PAYLOAD_KEYS = new Set([
  'prompt',
  'stdout',
  'stderr',
  'env',
  'environment',
  'proxy',
]);

const RESOURCE_ID_KEYS = new Set(['fileKey', 'sourceFileKey']);

const ID_KEYS = new Set([
  'chatId',
  'senderId',
  'sender',
  'openId',
  'operatorId',
  'userId',
  'msgId',
  'messageId',
  'sourceMessageId',
  'sessionId',
  'threadId',
  'docToken',
  'fileToken',
  'fileKey',
  'sourceFileKey',
  'commentId',
  'rootCommentId',
  'replyId',
  'reactionId',
  'scope',
  'appId',
]);

const MAX_LOG_STRING_CHARS = 4096;
const CREDENTIAL_JSON_FIELD_RE =
  /("(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)"\s*:\s*")[^"]*(")/gi;
const ESCAPED_CREDENTIAL_JSON_FIELD_RE =
  /(\\\"(?:secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;
const RESOURCE_JSON_FIELD_RE =
  /("(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)"\s*:\s*")[^"]*(")/gi;
const ESCAPED_RESOURCE_JSON_FIELD_RE =
  /(\\\"(?:fileKey|sourceFileKey|file_key|source_file_key|imageKey|image_key|mediaKey|media_key)\\\"\s*:\s*\\\")[^\\]*(\\\")/gi;

interface SanitizeOptions {
  redactIds: boolean;
}

const LOCAL_LOG_SANITIZE: SanitizeOptions = { redactIds: false };
const EXTERNAL_SANITIZE: SanitizeOptions = { redactIds: true };

function sanitizeLogEntry(
  entry: Record<string, unknown>,
  options: SanitizeOptions = EXTERNAL_SANITIZE,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = sanitizeLogValue(key, value, options);
  }
  return out;
}

function sanitizeLogValue(
  key: string,
  value: unknown,
  options: SanitizeOptions = EXTERNAL_SANITIZE,
): unknown {
  const normalizedKey = key.startsWith('_') ? key.slice(1) : key;
  if (value === undefined) return undefined;
  if (RAW_PAYLOAD_KEYS.has(normalizedKey)) return '[REDACTED]';
  if (/token|secret|authorization/i.test(normalizedKey)) return '[REDACTED]';
  if (/attachment.*path|media.*path|^(cwd|cwdRealpath|path|absPath)$/i.test(normalizedKey)) {
    return '[REDACTED_PATH]';
  }
  if (RESOURCE_ID_KEYS.has(normalizedKey)) return '[REDACTED_RESOURCE]';
  if (options.redactIds && ID_KEYS.has(normalizedKey)) return redactId(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item, options));
  }
  if (value && typeof value === 'object') {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = sanitizeLogValue(nestedKey, nestedValue, options);
    }
    return nested;
  }
  if (typeof value === 'string') {
    const redacted = redactDiagnosticText(value);
    if (redacted.length > MAX_LOG_STRING_CHARS) {
      return `${redacted.slice(0, MAX_LOG_STRING_CHARS)}...[truncated]`;
    }
    return redacted;
  }
  return value;
}

function redactId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 6) return value;
  return `...${value.slice(-6)}`;
}

function emit(level: Level, phase: string, event: string, fields: LogFields = {}): void {
  const ctx = als.getStore() ?? {};
  const entry = sanitizeLogEntry({
    ts: formatLocalTimestamp(loggerOptions.now()),
    level,
    phase,
    event,
    ...ctx,
  }, LOCAL_LOG_SANITIZE);
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = sanitizeLogValue(`_${k}`, v, LOCAL_LOG_SANITIZE);
    } else {
      entry[k] = sanitizeLogValue(k, v, LOCAL_LOG_SANITIZE);
    }
  }

  const externalEntry = sanitizeLogEntry(entry, EXTERNAL_SANITIZE);
  const telemetrySafe = telemetryPayloadFromEntry(externalEntry);
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* swallow disk errors — logging should never crash the bot */
    }
  }

  try {
    telemetry().emit({
      level,
      phase,
      event,
      fields: telemetrySafe.fields,
      ctx: telemetrySafe.ctx,
      ts: String(entry.ts),
    });
  } catch {
    /* never break logging */
  }
  if (level === 'error') {
    try {
      telemetry().recordError(telemetrySafe.fields.err ?? `${phase}.${event}`, {
        phase,
        event,
        ...telemetrySafe.ctx,
        ...telemetrySafe.fields,
      });
    } catch {
      /* never break logging */
    }
  }

  // Stdout is the user-facing tail: warns, errors, and a curated list
  // of info events (WS lifecycle, message intake, run final). The full
  // detail always lives in the file regardless.
  const showOnStdout =
    level !== 'info' || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(formatStdout(level, phase, event, telemetrySafe.ctx, telemetrySafe.fields));
}

function telemetryPayloadFromEntry(entry: Record<string, unknown>): {
  ctx: LogContext;
  fields: LogFields;
} {
  const ctx: LogContext = {};
  if (typeof entry.traceId === 'string') ctx.traceId = entry.traceId;
  if (typeof entry.chatId === 'string') ctx.chatId = entry.chatId;
  if (typeof entry.msgId === 'string') ctx.msgId = entry.msgId;

  const fields: LogFields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (TELEMETRY_ENVELOPE_KEYS.has(key) || value === undefined) continue;
    fields[key] = value;
  }
  return { ctx, fields };
}

function formatStdout(
  level: Level,
  phase: string,
  event: string,
  ctx: LogContext,
  fields: LogFields,
): string {
  // Friendly shapes for the few events users actually see.
  if (phase === 'ws') {
    if (event === 'connected') {
      const bot = fields.bot ?? '-';
      const appId = fields.appId ? ` (${fields.appId})` : '';
      const agent = fields.agent ?? '-';
      const proc = fields.procId ? `  进程: ${fields.procId}` : '';
      return `✓ 已连接  bot: ${bot}${appId}  agent: ${agent}${proc}`;
    }
    if (event === 'reconnecting') return '↻ 正在重连…';
    if (event === 'reconnected') return '✓ 已重连';
    if (event === 'fail') return `✗ WS 错误: ${fields.err ?? ''}`;
  }
  if (phase === 'intake' && event === 'enter') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const mode = fields.chatMode ?? fields.chatType ?? '?';
    const scope = shortId(fields.scope);
    const sender = fields.sender ?? '-';
    const msg = shortId(ctx.msgId ?? fields.msgId ?? fields._msgId);
    const preview = fields.preview ?? '';
    return `▸ ${mode}/${c} scope=${scope} sender=${sender} msg=${msg}: ${preview}`;
  }
  if (phase === 'intake' && event === 'command') {
    const scope = shortId(fields.scope);
    return `  ↳ command scope=${scope} dropped=${fields.droppedPending ?? 0}`;
  }
  if (phase === 'run' && event === 'started') {
    const scope = shortId(fields.scope);
    return `  ▶ run start scope=${scope} run=${shortId(fields.runId)} queue=${fields.queueWaitMs ?? 0}ms`;
  }
  if (phase === 'run' && (event === 'completed' || event === 'failed')) {
    const result = event === 'failed' ? 'failed' : fields.result ?? 'done';
    const mark = event === 'failed' ? '✗' : result === 'interrupted' ? '⏹' : '✓';
    const scope = shortId(fields.scope);
    const duration = formatDurationMs(fields.durationMs);
    return `  ${mark} run ${result} scope=${scope} run=${shortId(fields.runId)}${duration ? ` duration=${duration}` : ''}`;
  }
  if (phase === 'cot' && event === 'created') {
    return `  ◇ cot created message=${shortId(fields.messageId)} cot=${shortId(fields.cotId)}`;
  }
  if (phase === 'cot' && event === 'completed') {
    return `  ◇ cot completed cot=${shortId(fields.cotId)} reason=${fields.reason ?? '-'}`;
  }
  if (phase === 'outbound' && event === 'markdown-stream-fallback') {
    return `  ⚠ markdown stream fallback: ${fields.err ?? ''}`;
  }
  if (phase === 'outbound' && event === 'sent') {
    const scope = shortId(fields.scope);
    const reply = fields.replyInThread === true ? 'thread' : 'reply';
    return `  ↗ sent ${fields.type ?? 'message'} scope=${scope} ${reply}=${shortId(fields.replyTo)} msg=${shortId(fields.messageId)}`;
  }
  if (phase === 'card' && event === 'final') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const t = fields.terminal;
    const mark = t === 'done' ? '✓' : t === 'interrupted' ? '⏹' : '✗';
    const scope = fields.scope ? shortId(fields.scope) : c;
    return `  ${mark} ${scope} ${t}`;
  }

  // Generic compact form for warns / errors / unmatched info.
  const ctxBits: string[] = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(' ')}` : '';
  const summary = formatFields(fields);
  const tag = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '·';
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ''}`;
}

function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatLocalTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${sign}${oh}:${om}`;
}

function shortId(value: unknown): string {
  if (value === undefined || value === null) return '-';
  const s = String(value);
  const last = s.includes(':') ? s.split(':').at(-1) ?? s : s;
  const bare = last.startsWith('...') ? last.slice(3) : last;
  return bare.length > 6 ? bare.slice(-6) : bare;
}

function formatDurationMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}

function formatFields(fields: LogFields): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    if (k === 'stack') continue; // skip in stdout, kept in JSON
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}…` : s}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(' ');
}

export const log = {
  info(phase: string, event: string, fields?: LogFields): void {
    emit('info', phase, event, fields);
  },
  warn(phase: string, event: string, fields?: LogFields): void {
    emit('warn', phase, event, fields);
  },
  fail(phase: string, err: unknown, fields?: LogFields): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Axios errors carry the Feishu API response at err.response.data — that's
    // where { code, msg, ... } lives. Surface it explicitly so log.fail
    // captures the *actual* server-side reason, not just "status code 400".
    const apiData = (err as { response?: { data?: unknown } })?.response?.data;
    const apiStatus = (err as { response?: { status?: unknown } })?.response?.status;
    emit('error', phase, 'fail', {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack,
    });
  },
};

export function configureLogger(opts: Partial<LoggerOptions>): void {
  if (stream) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
  }
  stream = null;
  currentDate = '';
  loggerOptions = {
    ...(opts.logsDir !== undefined ? { logsDir: opts.logsDir } : { logsDir: loggerOptions.logsDir }),
    retentionDays: Math.max(1, opts.retentionDays ?? loggerOptions.retentionDays),
    now: opts.now ?? loggerOptions.now,
  };
}

export async function closeLogger(): Promise<void> {
  const s = stream;
  if (!s) return;
  stream = null;
  currentDate = '';
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    s.once('error', done);
    if (s.closed || s.destroyed) {
      done();
      return;
    }
    s.end(done);
  });
}

export function getLoggerConfig(): LoggerOptions {
  return { ...loggerOptions };
}

export async function flushLogger(): Promise<void> {
  const s = stream;
  if (!s) return;
  await new Promise<void>((resolve) => {
    s.write('', () => resolve());
  });
}

/**
 * Run `fn` inside a logging context. All `log.*` calls inside (including
 * across awaits) pick up `traceId` / `chatId` / `msgId` automatically.
 */
export function withTrace<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const traceId = ctx.traceId ?? newTraceId();
  return als.run({ ...ctx, traceId }, fn);
}

export function newTraceId(): string {
  // Short, easy-to-grep, base36 random.
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Scrub a log buffer of identifying / credential material before it leaves
 * the local machine — specifically, before /doctor feeds it to Claude (the
 * Anthropic API will see it) and before the analysis card lands in a
 * Feishu chat (the Lark server may cache card contents).
 *
 * Conservative: keeps log structure intact so Claude can still correlate by
 * traceId / phase / event. Only the *values* of identifying fields shrink
 * to a last-6-char suffix, and known credential fields become [REDACTED].
 *
 * Pattern-based on purpose — parsing each line as JSON would skip lines the
 * scrubber doesn't fully understand and is much slower for ~60KB of input.
 */
export function sanitizeLogsForDoctor(logs: string): string {
  let out = logs;
  // ID-like JSON fields → last 6 chars only. The 8-char minimum on the
  // value avoids matching short metadata that happens to share a key name.
  out = out.replace(
    /"(chatId|senderId|sender|openId|operatorId|userId|msgId|messageId)":"([^"]{8,})"/g,
    (_, key: string, val: string) => `"${key}":"…${val.slice(-6)}"`,
  );
  // Credential fields → fully redacted. Case-insensitive on the key.
  out = out.replace(
    /"(secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)":"[^"]*"/gi,
    (_, key: string) => `"${key}":"[REDACTED]"`,
  );
  out = redactJsonCredentialText(out);
  // URL-style tokens in error messages: `?access_token=t-xxx`.
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token)=[A-Za-z0-9._\-+/=]+/g,
    '$1=[REDACTED]',
  );
  // HTTP Authorization headers embedded in stringified errors.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]');
  out = out.replace(/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization=[REDACTED]');
  out = out.replace(
    /"(prompt|stdout|stderr|env|proxy|attachmentPath|mediaPath|path|cwd|cwdRealpath|absPath)":[^,\n}]*/gi,
    (_, key: string) => `"${key}":"[REDACTED]"`,
  );
  return redactDiagnosticText(out);
}

export function redactDiagnosticText(text: string): string {
  let out = redactJsonCredentialText(text);
  out = redactResourceText(out);
  out = out.replace(
    /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    '$1[REDACTED]',
  );
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+/g, '$1[REDACTED]');
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token|app_secret|appSecret|secret|token|doc_token|file_token|authorization)=([^&\s"',}]+)/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(
    /(^|[\s"'=])((?:\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/[^\s"',)]+))/g,
    '$1[REDACTED_PATH]',
  );
  out = out.replace(/(^|[\s"'=])(~\/[^\s"',)]+)/g, '$1[REDACTED_PATH]');
  out = out.replace(/[A-Za-z]:\\[^\s"',)]+/g, '[REDACTED_PATH]');
  return out;
}

function redactJsonCredentialText(text: string): string {
  return text
    .replace(CREDENTIAL_JSON_FIELD_RE, '$1[REDACTED]$2')
    .replace(ESCAPED_CREDENTIAL_JSON_FIELD_RE, '$1[REDACTED]$2');
}

function redactResourceText(text: string): string {
  return text
    .replace(RESOURCE_JSON_FIELD_RE, '$1[REDACTED_RESOURCE]$2')
    .replace(ESCAPED_RESOURCE_JSON_FIELD_RE, '$1[REDACTED_RESOURCE]$2')
    .replace(
      /<\s*(?:file|image|img|audio|video|media|folder)\b[^>]*\bkey\s*=\s*["'][^"']+["'][^>]*>/gi,
      '[REDACTED_RESOURCE]',
    )
    .replace(/!?\[[^\]]*]\((?:file|img|image|media)_[^)]+\)/gi, '[REDACTED_RESOURCE]')
    .replace(
      /\b(?:file|img|image|media)_(?:v\d+_)?[A-Za-z0-9][A-Za-z0-9._-]{8,}\b/g,
      '[REDACTED_RESOURCE]',
    );
}

/**
 * Read the tail of today's (and optionally yesterday's) log file.
 *
 * Returns up to `maxBytes` of complete JSON lines, oldest-first. If the
 * tail starts mid-line we drop the partial leader.
 */
export async function readRecentLogs(opts: { maxBytes: number }): Promise<string> {
  const dir = logsDir();
  if (!dir) return '';
  const today = todayKey();
  const yesterday = new Date(loggerOptions.now().getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  const todayPath = join(dir, logFileName(today));
  const yesterdayPath = join(dir, logFileName(yesterday));

  const tail = await readTail(todayPath, opts.maxBytes);
  if (tail.length >= opts.maxBytes / 2) return tail;

  // Top up from yesterday's file if today's is sparse.
  const remaining = opts.maxBytes - Buffer.byteLength(tail, 'utf8');
  const earlier = await readTail(yesterdayPath, remaining);
  return earlier + tail;
}

/**
 * Delete log files older than the retention window. Best-effort, called
 * on bridge startup. Returns the number of files removed.
 */
export async function gcOldLogs(): Promise<number> {
  const dir = logsDir();
  if (!dir) return 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = loggerOptions.now().getTime() - loggerOptions.retentionDays * 86_400_000;
  let removed = 0;
  for (const name of entries) {
    const m = name.match(/^bridge-(\d{4})(\d{2})(\d{2})\.jsonl$/);
    if (!m) continue;
    const fileMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isNaN(fileMs) || fileMs >= cutoff) continue;
    try {
      await rm(join(dir, name));
      removed++;
    } catch {
      /* skip */
    }
  }
  if (removed > 0) {
    log.info('logger', 'gc', { removed, retentionDays: loggerOptions.retentionDays });
  }
  return removed;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - maxBytes);
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      let content = buf.toString('utf8');
      if (start > 0) {
        const nl = content.indexOf('\n');
        if (nl !== -1) content = content.slice(nl + 1);
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function reportMetric(
  name: string,
  value: number,
  tags?: Record<string, string>,
): void {
  try {
    telemetry().recordMetric(name, value, sanitizeMetricTags(tags));
  } catch {
    /* never break runtime behavior */
  }
}

export function reportError(err: unknown, ctx?: Record<string, unknown>): void {
  try {
    telemetry().recordError(sanitizeTelemetryError(err), sanitizeTelemetryContext(ctx));
  } catch {
    /* never break runtime behavior */
  }
}

function sanitizeMetricTags(tags?: Record<string, string>): Record<string, string> | undefined {
  if (!tags) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const sanitized = sanitizeLogValue(key, value);
    out[key] = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
  }
  return out;
}

function sanitizeTelemetryContext(
  ctx?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = sanitizeLogValue(key, value);
  }
  return out;
}

function sanitizeTelemetryError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: sanitizeLogValue('err', err.message),
      ...(err.stack ? { stack: sanitizeLogValue('stack', err.stack) } : {}),
    };
  }
  return sanitizeLogValue('err', err);
}
