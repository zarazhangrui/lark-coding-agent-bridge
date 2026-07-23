import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const MAX_BODY_BYTES = 256 * 1024;

/** Reject anything not addressed to localhost, and any cross-origin request. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const host = ((req.headers.host ?? '').split(':')[0] ?? '').replace(/^\[|\]$/g, '');
  if (host && !LOCALHOST_HOSTS.has(host) && !LOCALHOST_HOSTS.has(`[${host}]`)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCALHOST_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Constant-time token check against `x-ui-token` header or `?token=`. */
export function checkToken(req: IncomingMessage, url: URL, token: string): boolean {
  const provided =
    (req.headers['x-ui-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, html: string): void {
  send(res, 200, 'text/html; charset=utf-8', html);
}

export function sendJs(res: ServerResponse, js: string): void {
  send(res, 200, 'application/javascript; charset=utf-8', js);
}

/** HTTP-shaped error the servers turn into a JSON error response. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
