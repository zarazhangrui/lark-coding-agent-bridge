import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configurePaths, paths } from '../config/paths';
import type { AgentKind } from '../config/schema';

export interface AgentSelectionOptions {
  config?: string;
  agent?: AgentKind;
}

export function resolveDataLocation(opts: AgentSelectionOptions): {
  configPath: string;
  customized: boolean;
} {
  if (opts.config) return { configPath: resolve(opts.config), customized: true };
  if (opts.agent === 'codex') {
    return { configPath: join(homedir(), '.lark-codex', 'config.json'), customized: true };
  }
  return { configPath: paths.configFile, customized: false };
}

export function applyDataLocation(opts: AgentSelectionOptions): string {
  const { configPath, customized } = resolveDataLocation(opts);
  if (customized) configurePaths(dirname(configPath));
  return configPath;
}

export function runArgsForSelection(opts: AgentSelectionOptions): string[] {
  const args = ['run'];
  if (opts.config) args.push('-c', resolve(opts.config));
  if (opts.agent === 'codex') args.push('--codex');
  if (opts.agent === 'claude') args.push('--claude');
  return args;
}
