import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const SESSION_CONTEXT_FILE_ENV = 'LARK_CHANNEL_CONTEXT_FILE';
export const SESSION_CONTEXT_MAX_BYTES = 64 * 1024;

export interface SessionContextFile {
  path: string;
  content: string;
  bytes: number;
  truncated?: boolean;
}

export async function readSessionContextFileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionContextFile | undefined> {
  const rawPath = env[SESSION_CONTEXT_FILE_ENV]?.trim();
  if (!rawPath) return undefined;

  const path = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  const buf = await readFile(path);
  const truncated = buf.length > SESSION_CONTEXT_MAX_BYTES;
  const slice = truncated ? buf.subarray(0, SESSION_CONTEXT_MAX_BYTES) : buf;

  return {
    path,
    content: slice.toString('utf8'),
    bytes: buf.length,
    ...(truncated ? { truncated: true } : {}),
  };
}
