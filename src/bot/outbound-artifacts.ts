import type { LarkChannel, SendOptions } from '@larksuite/channel';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { RunState } from '../card/run-state';
import { log } from '../core/logger';

const OUTBOUND_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OUTBOUND_IMAGE_MAX_COUNT = 6;
const OUTBOUND_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const OUTBOUND_FILE_MAX_COUNT = 6;
const OUTBOUND_FILE_MAX_BYTES = 25 * 1024 * 1024;
const OUTBOUND_FILE_SCHEME = 'bridge-file:';

export async function sendOutboundArtifacts(
  channel: LarkChannel,
  chatId: string,
  state: RunState,
  cwd: string,
  sendOpts: SendOptions,
): Promise<void> {
  await sendOutboundImages(channel, chatId, state, cwd, sendOpts);
  await sendOutboundFiles(channel, chatId, state, cwd, sendOpts);
}

async function sendOutboundImages(
  channel: LarkChannel,
  chatId: string,
  state: RunState,
  cwd: string,
  sendOpts: SendOptions,
): Promise<void> {
  if (state.terminal === 'running') return;
  const candidates = extractOutboundImageCandidates(state);
  if (candidates.length === 0) return;
  const images = await resolveOutboundImageCandidates(candidates, cwd);
  if (images.length === 0) return;
  await allowOutboundDir(channel, cwd);

  for (const imagePath of images) {
    try {
      await channel.send(chatId, { image: { source: imagePath } }, sendOpts);
      log.info('media', 'outbound-image-sent', { path: imagePath });
    } catch (err) {
      log.fail('media', err, { step: 'outbound-image-send', path: imagePath });
    }
  }
}

async function sendOutboundFiles(
  channel: LarkChannel,
  chatId: string,
  state: RunState,
  cwd: string,
  sendOpts: SendOptions,
): Promise<void> {
  if (state.terminal === 'running') return;
  const candidates = extractOutboundFileCandidates(state);
  if (candidates.length === 0) return;
  const files = await resolveOutboundFileCandidates(candidates, cwd);
  if (files.length === 0) return;
  await allowOutboundDir(channel, cwd);

  for (const filePath of files) {
    try {
      await channel.send(chatId, { file: { source: filePath, fileName: basename(filePath) } }, sendOpts);
      log.info('media', 'outbound-file-sent', { path: filePath });
    } catch (err) {
      log.fail('media', err, { step: 'outbound-file-send', path: filePath });
    }
  }
}

export function extractOutboundImageCandidates(state: RunState): string[] {
  const out: string[] = [];
  for (const block of state.blocks) {
    if (block.kind !== 'text') continue;
    out.push(...extractImagePathsFromText(block.content));
  }
  return uniqueStrings(out).slice(0, OUTBOUND_IMAGE_MAX_COUNT * 3);
}

export function extractOutboundFileCandidates(state: RunState): string[] {
  const out: string[] = [];
  for (const block of state.blocks) {
    if (block.kind !== 'text') continue;
    out.push(...extractFilePathsFromText(block.content));
  }
  return uniqueStrings(out).slice(0, OUTBOUND_FILE_MAX_COUNT * 3);
}

function extractImagePathsFromText(text: string): string[] {
  const out: string[] = [];
  const markdownImage = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of text.matchAll(markdownImage)) {
    const raw = cleanImagePathCandidate(match[1]);
    if (raw) out.push(raw);
  }
  return out;
}

function extractFilePathsFromText(text: string): string[] {
  const out: string[] = [];
  const markdownLink = /(?<!!)\[[^\]]+]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of text.matchAll(markdownLink)) {
    const raw = cleanFilePathCandidate(match[1]);
    if (raw) out.push(raw);
  }
  return out;
}

function cleanImagePathCandidate(value: string | undefined): string | undefined {
  if (!value || /^https?:\/\//i.test(value)) return undefined;
  let s = value.trim();
  if (s.startsWith('file://')) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return undefined;
    }
  }
  s = s.replace(/[),.;，。；]+$/g, '');
  return s && OUTBOUND_IMAGE_EXTENSIONS.has(extname(s).toLowerCase()) ? s : undefined;
}

function cleanFilePathCandidate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let s = value.trim();
  if (!s.startsWith(OUTBOUND_FILE_SCHEME)) return undefined;
  s = s.slice(OUTBOUND_FILE_SCHEME.length);
  s = s.replace(/[),.;，。；]+$/g, '');
  if (!s || OUTBOUND_IMAGE_EXTENSIONS.has(extname(s).toLowerCase())) return undefined;
  return s;
}

export async function resolveOutboundImageCandidates(
  candidates: readonly string[],
  cwd: string,
): Promise<string[]> {
  const cwdReal = await realpath(cwd).catch(() => cwd);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (out.length >= OUTBOUND_IMAGE_MAX_COUNT) break;
    const abs = isAbsolute(candidate) ? candidate : resolve(cwdReal, candidate);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      continue;
    }
    if (!isPathInside(real, cwdReal)) continue;
    if (!OUTBOUND_IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) continue;
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size > OUTBOUND_IMAGE_MAX_BYTES) continue;
    out.push(real);
  }
  return uniqueStrings(out);
}

export async function resolveOutboundFileCandidates(
  candidates: readonly string[],
  cwd: string,
): Promise<string[]> {
  const cwdReal = await realpath(cwd).catch(() => cwd);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (out.length >= OUTBOUND_FILE_MAX_COUNT) break;
    const abs = isAbsolute(candidate) ? candidate : resolve(cwdReal, candidate);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      continue;
    }
    if (!isPathInside(real, cwdReal)) continue;
    if (OUTBOUND_IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) continue;
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size > OUTBOUND_FILE_MAX_BYTES) continue;
    out.push(real);
  }
  return uniqueStrings(out);
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

async function allowOutboundDir(channel: LarkChannel, cwd: string): Promise<void> {
  const sender = (channel as unknown as { sender?: { config?: { allowedFileDirs?: unknown } } }).sender;
  const cfg = sender?.config;
  if (!cfg || typeof cfg !== 'object') return;
  const cwdReal = await realpath(cwd).catch(() => cwd);
  const existing = Array.isArray(cfg.allowedFileDirs) ? cfg.allowedFileDirs : [];
  cfg.allowedFileDirs = uniqueStrings([...existing, cwdReal]);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
