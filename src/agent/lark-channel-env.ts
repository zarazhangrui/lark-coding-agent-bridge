import { accessSync, constants } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliDataDir?: string;
  larkCliBinPath?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  const larkCliDataDir =
    nonEmpty(context?.larkCliDataDir) ??
    nonEmpty(process.env.LARKSUITE_CLI_DATA_DIR) ??
    defaultLarkCliDataDir();
  if (larkCliDataDir) env.LARKSUITE_CLI_DATA_DIR = larkCliDataDir;

  const larkCliBinPath = resolveLarkCliBinPath(context?.larkCliBinPath);
  if (larkCliBinPath) {
    env.LARK_CHANNEL_LARK_CLI_BIN = larkCliBinPath;
    env.PATH = prependPath(dirname(larkCliBinPath), process.env.PATH);
  }

  return env;
}

function defaultLarkCliDataDir(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const home = nonEmpty(userInfo().homedir);
    return home ? join(home, '.local', 'share') : undefined;
  } catch {
    return undefined;
  }
}

function resolveLarkCliBinPath(configuredPath: string | undefined): string | undefined {
  const configured = nonEmpty(configuredPath) ?? nonEmpty(process.env.LARK_CHANNEL_LARK_CLI_BIN);
  if (configured) return isAbsolute(configured) ? configured : findExecutable(configured);
  return findExecutable('lark-cli');
}

function findExecutable(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(resolve(dir), command)) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function executableCandidates(dir: string, command: string): string[] {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of (process.env.PATHEXT ?? '').split(';')) {
    const trimmed = ext.trim();
    if (trimmed) candidates.push(join(dir, `${command}${trimmed}`));
  }
  return candidates;
}

function prependPath(dir: string, currentPath: string | undefined): string {
  const entries = (currentPath ?? '').split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return entries.join(delimiter);
  return [dir, ...entries].join(delimiter);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
