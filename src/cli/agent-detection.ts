import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'pi';

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function resolveExecutablePath(command: string): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}

function executableCandidates(dir: string, command: string): string[] {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join(dir, `${command}${ext}`));
  }
  return candidates;
}

function pathExts(): string[] {
  return (process.env.PATHEXT ?? '')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const candidates: Array<{ kind: AgentKind; command: string }> = [
    { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
    { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
    { kind: 'pi', command: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' },
  ];
  const detected: DetectedAgent[] = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  return detected;
}
