import { readAndPrune, resolveTarget, isAlive, unregister } from '../../runtime/registry';
import type { ProcessEntry } from '../../runtime/registry';

/**
 * Pretty-print the list of running lark-channel-bridge processes.
 *
 * `readAndPrune` is a legacy name; read-only views never rewrite registry
 * state. Persistence happens on the next `register` / `unregister` /
 * `updateEntry` call.
 */
export function runPs(): void {
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

export async function runKillCli(target: string | undefined): Promise<void> {
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
  let result: StopProcessEntryResult;
  try {
    result = await stopProcessEntry(entry);
  } catch (err) {
    console.error(`✗ 关闭失败:${(err as Error).message}`);
    process.exit(1);
  }

  if (result === 'not-running') {
    // Hard-killed processes (crash, Stop-Process, task-scheduler kill) never
    // unregister themselves; drop the ghost entry so `ps` stops listing it.
    await unregister(entry.id);
    console.log(`✓ bot ${entry.id} 的进程已不存在,已清理注册表残留。`);
    return;
  }
  if (result === 'killed') {
    console.log(`✓ 已强制关闭 bot ${entry.id}。`);
    return;
  }
  console.log(`✓ 已关闭 bot ${entry.id}。`);
}

export type StopProcessEntryResult = 'terminated' | 'killed' | 'not-running';

export async function stopProcessEntry(
  entry: Pick<ProcessEntry, 'pid'> & { id?: string },
  timeoutMs = 2000,
): Promise<StopProcessEntryResult> {
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'not-running';
    throw err;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      return 'terminated';
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  process.kill(entry.pid, 'SIGKILL');
  const forceDeadline = Date.now() + timeoutMs;
  while (Date.now() < forceDeadline) {
    if (!isAlive(entry.pid)) {
      return 'killed';
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process ${entry.pid} did not exit after SIGKILL`);
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
