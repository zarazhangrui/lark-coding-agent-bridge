import { homedir } from 'node:os';
import { join } from 'node:path';

export function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeProjectDir(cwd: string, homeDir: string = homedir()): string {
  return join(homeDir, '.claude', 'projects', encodeClaudeProjectPath(cwd));
}
