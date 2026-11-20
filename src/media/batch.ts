import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { log } from '../core/logger';
import { safeExtensionForMime, type NormalizedAttachment } from './attachment';

/**
 * Attachment batches: when one message batch carries several attachments,
 * link them into `<workspace>/.lark-batches/<time>-<hash>/` with their real
 * names and a delivery-order prefix (01-, 02-, …) plus a manifest.json, so the
 * agent can address "the 3rd picture". The per-attachment paths in the prompt
 * stay as they are; the batch directory is additional.
 */

export const ATTACHMENT_BATCH_DIR = '.lark-batches';

/** Skips are not failures: stickers and audio/video are never processed. */
const SKIP_REASONS = new Set(['sticker', 'unsupported-kind']);
const REASON_TEXT: Record<string, string> = {
  'too-many-attachments': '数量超限',
  'file-too-large': '单个文件过大',
  'image-too-large': '图片过大',
  'run-too-large': '本批总体积超限',
};

type BatchAttachment = Pick<
  NormalizedAttachment,
  'decision' | 'rejectionReason' | 'path' | 'kind' | 'mime' | 'size' | 'originalName' | 'hash'
>;

/**
 * One line about attachments that were dropped, so a drop is never silent.
 * Empty when everything was accepted or only skip-type items were left out.
 */
export function renderAttachmentNotice(attachments: readonly BatchAttachment[]): string {
  if (attachments.length === 0) return '';
  const accepted = attachments.filter((a) => a.decision === 'accepted');
  const rejected = attachments.filter(
    (a) => a.decision !== 'accepted' && !SKIP_REASONS.has(a.rejectionReason ?? ''),
  );
  if (rejected.length === 0) return '';
  const byReason = new Map<string, number>();
  for (const a of rejected) {
    const key = REASON_TEXT[a.rejectionReason ?? ''] ?? '未能处理';
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const detail = [...byReason.entries()].map(([r, n]) => `${n} 个（${r}）`).join('、');
  const total = accepted.length + rejected.length;
  if (accepted.length === 0) return `⚠️ 没有任何附件进入本次处理：共 ${total} 个，全部未处理 · ${detail}`;
  return `⚠️ 附件：收到 ${total} 个，已处理 ${accepted.length} 个；${detail}未处理`;
}

/**
 * Link name for one attachment. The original name may contain `../` or path
 * separators; used as is it would land outside the workspace.
 */
export function safeAttachmentName(index: number, a: Pick<BatchAttachment, 'originalName' | 'mime' | 'kind'>): string {
  const raw = typeof a.originalName === 'string' ? a.originalName : '';
  let name = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').trim();
  if (!name) name = `${a.kind ?? 'file'}.${a.mime ? safeExtensionForMime(a.mime) : 'bin'}`;
  if (name.length > 80) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 80 - ext.length) + ext;
  }
  return `${String(index + 1).padStart(2, '0')}-${name}`;
}

export interface LandedBatch {
  dir: string;
  count: number;
  items: Array<{
    name: string;
    kind: string;
    mime?: string;
    size: number;
    originalName?: string;
    hash?: string;
    cachePath: string;
    linked: boolean;
  }>;
}

/**
 * Land accepted attachments as a batch directory. Symlinks, not copies: the
 * cache already has TTL / size management and a copy would live on its own.
 * Returns undefined below the threshold — the caller keeps the per-file paths.
 */
export async function landAttachmentBatch(
  attachments: readonly BatchAttachment[],
  cwdRealpath: string | undefined,
  cfg: { batchThreshold: number; batchKeep: number },
  now: Date = new Date(),
): Promise<LandedBatch | undefined> {
  const accepted = attachments.filter((a) => a.decision === 'accepted');
  if (accepted.length < cfg.batchThreshold) return undefined;
  if (!cwdRealpath) return undefined;
  const root = join(cwdRealpath, ATTACHMENT_BATCH_DIR);
  // The bridge is not sandboxed: never follow a `.lark-batches` that is a
  // link (an agent or a cloned repo could point it anywhere, and pruning
  // deletes inside it).
  await mkdir(root, { recursive: true });
  const st = await lstat(root);
  const real = await realpath(root);
  if (!st.isDirectory() || st.isSymbolicLink() || !real.startsWith(cwdRealpath + sep)) {
    throw new Error(`${ATTACHMENT_BATCH_DIR} is not a plain directory inside the workspace`);
  }
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const short = (accepted[0]?.hash ?? String(now.getTime())).slice(0, 8);
  // Random suffix: two scopes sharing a workspace can land the same first file in the same second.
  const dir = join(root, `${stamp}-${short}-${randomBytes(3).toString('hex')}`);
  await mkdir(dir);
  const items: LandedBatch['items'] = [];
  for (const [i, a] of accepted.entries()) {
    const name = safeAttachmentName(i, a);
    let linked = false;
    if (a.path) {
      try {
        await symlink(a.path, join(dir, name));
        linked = true;
      } catch {
        linked = false;
      }
    }
    items.push({
      name,
      kind: a.kind,
      ...(a.mime ? { mime: a.mime } : {}),
      size: a.size,
      ...(a.originalName ? { originalName: a.originalName } : {}),
      ...(a.hash ? { hash: a.hash } : {}),
      cachePath: a.path,
      linked,
    });
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ createdAt: now.toISOString(), count: items.length, items }, null, 2),
    'utf8',
  );
  await pruneAttachmentBatches(root, cfg.batchKeep).catch((err) =>
    log.warn('attachment', 'batch-prune-failed', { err: String(err) }),
  );
  return { dir, count: items.length, items };
}

/**
 * Keep the newest `keep` batches. Names start with a timestamp, so name order
 * is time order. Only real directories that hold a manifest.json count as
 * batches; anything else in there is left alone.
 */
export async function pruneAttachmentBatches(root: string, keep: number): Promise<void> {
  const st = await lstat(root).catch(() => undefined);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return;
  const entries = await readdir(root).catch(() => [] as string[]);
  const dirs: string[] = [];
  for (const n of entries.filter((x) => /^\d{8,14}-/.test(x)).sort()) {
    const e = await lstat(join(root, n)).catch(() => undefined);
    const m = e?.isDirectory() ? await lstat(join(root, n, 'manifest.json')).catch(() => undefined) : undefined;
    if (e && e.isDirectory() && !e.isSymbolicLink() && m?.isFile()) dirs.push(n);
  }
  if (dirs.length <= keep) return;
  for (const name of dirs.slice(0, dirs.length - keep)) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Instruction lines added to the prompt when a batch directory was landed. */
export function batchInstructions(batch: LandedBatch): string[] {
  return [
    `本次的 ${batch.count} 个附件已按投递顺序整理到批次目录：${batch.dir}`,
    '目录里是带真实文件名的符号链接（序号前缀 = 投递顺序，如 01- 02-），另有 manifest.json 记录类型/大小/原始文件名。',
    '用户说「第几张」时按序号对应。也可直接读 <user_input> 里的单个附件路径。',
  ];
}
