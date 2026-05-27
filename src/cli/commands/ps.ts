import { readAndPrune, resolveTarget, isAlive } from '../../runtime/registry';
import type { AgentSelectionOptions } from '../agent-options';
import { applyDataLocation } from '../agent-options';

/**
 * Pretty-print the list of running lark-channel-bridge processes.
 *
 * `readAndPrune` drops dead entries but does not persist the pruned state —
 * fine for a read-only view. Persistence happens on the next `register` /
 * `unregister` / `updateEntry` call.
 */
export function runPs(opts: AgentSelectionOptions = {}): void {
  applyDataLocation(opts);
  const live = readAndPrune();
  if (live.length === 0) {
    console.log('当前没有 bot 在运行。');
    return;
  }
  console.log(`# 当前共 ${live.length} 个 bot 在运行\n`);
  const rows = live.map((e, idx) => {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const app = e.botName ? `${e.botName} (${e.appId})` : e.appId;
    return {
      idx: String(idx + 1),
      id: e.id,
      pid: String(e.pid),
      app,
      started: ago,
      version: e.version,
    };
  });
  const headers = { idx: '#', id: 'ID', pid: 'PID', app: 'Bot', started: '启动', version: '版本' };
  printTable([headers, ...rows]);
}

export async function runKillCli(
  target: string | undefined,
  opts: AgentSelectionOptions = {},
): Promise<void> {
  applyDataLocation(opts);
  if (!target) {
    console.error('用法: lark-channel-bridge kill <bot id 或序号>');
    process.exit(1);
  }
  const entry = resolveTarget(target);
  if (!entry) {
    console.error(`✗ 没找到匹配的 bot:${target}`);
    console.error('  用 `lark-channel-bridge ps` 看可选目标。');
    process.exit(1);
  }
  console.log(`正在关闭 bot ${entry.id}…`);
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    console.error(`✗ 关闭失败:${(err as Error).message}`);
    process.exit(1);
  }
  // Poll for up to 2s; SIGKILL as last resort. 100ms poll keeps the wait
  // tight on quick exits without spamming kill(0).
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      console.log(`✓ 已关闭 bot ${entry.id}。`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn('⚠️ 2 秒内没退出,强制关闭。');
  try {
    process.kill(entry.pid, 'SIGKILL');
  } catch (err) {
    console.error(`✗ 强制关闭失败:${(err as Error).message}`);
    process.exit(1);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

/** Minimal fixed-width table. Header row is index 0. */
function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const headerRow = rows[0];
  if (!headerRow) return;
  const cols = Object.keys(headerRow);
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = Math.max(...rows.map((r) => displayWidth(r[col] ?? '')));
  }
  for (const r of rows) {
    const line = cols
      .map((c) => padEndDisplay(r[c] ?? '', widths[c] ?? 0))
      .join('  ');
    console.log(line);
  }
}

function displayWidth(s: string): number {
  // Approximate — CJK chars take 2 cells. Avoids pulling in wcwidth.
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

function padEndDisplay(s: string, target: number): string {
  const pad = target - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}
