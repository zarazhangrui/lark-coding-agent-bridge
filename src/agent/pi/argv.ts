import type { AccessMode } from '../../config/permissions';

export interface BuildPiArgsInput {
  accessMode: AccessMode;
  sessionId?: string;
  images?: readonly string[];
}

export function buildPiArgs(input: BuildPiArgsInput): string[] {
  if (
    input.accessMode !== 'read-only' &&
    input.accessMode !== 'workspace' &&
    input.accessMode !== 'full'
  ) {
    throw new Error(`unsafe access mode: ${input.accessMode}`);
  }

  const args = ['--mode', 'json'];

  if (input.sessionId) {
    args.push('--session', input.sessionId);
  }

  // pi has no native workspace-scoped sandbox: 'workspace' and 'full' both
  // run unrestricted; only 'read-only' gets a --tools allowlist.
  if (input.accessMode === 'read-only') {
    args.push('--tools', 'read,grep,find,ls');
  }

  for (const image of input.images ?? []) {
    args.push(`@${image}`);
  }

  return args;
}
