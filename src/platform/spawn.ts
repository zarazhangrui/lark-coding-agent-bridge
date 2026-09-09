import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], options);
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  // lark-cli auto-detects its agent context from env signals
  // (OPENCLAW_HOME / HERMES_HOME / LARK_CHANNEL) and rejects an explicit
  // --source that contradicts the detected one. On machines where another
  // agent tool (e.g. hermes) installed a user-level HERMES_HOME, every
  // lark-cli child would be detected as that agent and `--source
  // lark-channel` fails with a validation error. Child processes spawned by
  // the bridge are always in lark-channel context, so foreign detection
  // signals must not leak through.
  for (const existing of Object.keys(out)) {
    const lower = existing.toLowerCase();
    if (lower === 'hermes_home' || lower === 'openclaw_home') {
      delete out[existing];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
