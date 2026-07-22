import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnProcessSync } from '../../platform/spawn';

const DEFAULT_RESULTS_DIR = '/Users/YUYSONG/Agents/AIOS Framework/results';
const BUG_ISSUE_PATTERN = /\bbug\b|\bfix\b|修复|排查|卡死|失败|不工作/i;
const SNAPSHOT_LINE_LIMIT = 500;

type SpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

interface LogSnapshot {
  path: string;
  dir: string;
}

interface MulticaIssueCreateDeps {
  resultsDir?: string;
  spawnSync?: SpawnSync;
  warn?: (message: string) => void;
}

export async function runMulticaIssueCreate(
  args: readonly string[],
  deps: MulticaIssueCreateDeps = {},
): Promise<number> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let snapshot: LogSnapshot | undefined;

  try {
    if (await isBugIssueCreate(args)) {
      snapshot = await createLatestLogSnapshot(deps.resultsDir ?? DEFAULT_RESULTS_DIR, warn);
    }

    const createArgs = ['issue', 'create', ...args];
    if (snapshot) createArgs.push('--attachment', snapshot.path);

    const result = (deps.spawnSync ?? spawnProcessSync)('multica', createArgs, { stdio: 'inherit' });
    return typeof result.status === 'number' ? result.status : 1;
  } finally {
    if (snapshot) {
      await rm(snapshot.dir, { recursive: true, force: true });
    }
  }
}

export async function isBugIssueCreate(args: readonly string[]): Promise<boolean> {
  const title = getOptionValue(args, '--title');
  if (title && BUG_ISSUE_PATTERN.test(title)) return true;

  const descriptionFile = getOptionValue(args, '--description-file');
  if (!descriptionFile) return false;

  try {
    const description = await readFile(descriptionFile, 'utf8');
    return BUG_ISSUE_PATTERN.test(description);
  } catch {
    return false;
  }
}

async function createLatestLogSnapshot(
  resultsDir: string,
  warn: (message: string) => void,
): Promise<LogSnapshot | undefined> {
  const latestLog = await findLatestLogFile(resultsDir);
  if (!latestLog) {
    warn(`Warning: no log file found under ${resultsDir}; creating Bug issue without a log snapshot.`);
    return undefined;
  }

  const content = await readFile(latestLog, 'utf8');
  const lines = content.split(/\r?\n/);
  const tail = lines.slice(-SNAPSHOT_LINE_LIMIT).join('\n');
  if (!tail.trim()) {
    warn(`Warning: latest log file ${latestLog} is empty; creating Bug issue without a log snapshot.`);
    return undefined;
  }

  const dir = await mkdtemp(join(tmpdir(), 'lark-channel-multica-bug-log-'));
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const path = join(dir, `bug-log-snapshot-${stamp}-${process.pid}.log`);
  await writeFile(path, tail, 'utf8');
  return { path, dir };
}

async function findLatestLogFile(resultsDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(resultsDir);
  } catch {
    return undefined;
  }

  let latest: { path: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const path = join(resultsDir, name);
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (!latest || fileStat.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: fileStat.mtimeMs };
  }

  return latest?.path;
}

function getOptionValue(args: readonly string[], option: string): string | undefined {
  const prefix = `${option}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === option) {
      const value = args[i + 1];
      if (value && !value.startsWith('--')) return value;
    }
  }
  return undefined;
}

export function multicaIssueCreateArgsFromProcessArgv(argv: readonly string[]): string[] {
  const commandIndex = argv.findIndex((arg) => basename(arg) === 'multica-issue-create' || arg === 'multica-issue-create');
  if (commandIndex >= 0) return argv.slice(commandIndex + 1);

  const subcommandIndex = argv.indexOf('multica-issue-create');
  return subcommandIndex >= 0 ? argv.slice(subcommandIndex + 1) : [];
}
