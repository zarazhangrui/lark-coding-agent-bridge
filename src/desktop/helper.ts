import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StartFloatingBallHelperInput {
  rootDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnHelper?: typeof spawn;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

export function resolveFloatingBallHelperCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..');
  return [
    env.LARK_CHANNEL_FLOATING_BALL_HELPER,
    join(packageRoot, 'desktop', 'macos-floating-ball', 'LarkChannelFloatingBall'),
    join(packageRoot, 'desktop', 'macos-floating-ball', '.build', 'release', 'LarkChannelFloatingBall'),
  ].filter((value): value is string => Boolean(value));
}

export function resolveFloatingBallHelperPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return resolveFloatingBallHelperCandidates(env).find((candidate) => exists(candidate));
}

export async function startFloatingBallHelper(
  input: StartFloatingBallHelperInput,
): Promise<boolean> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const helperPath = resolveFloatingBallHelperPath(input.env);
  if (!helperPath) {
    input.onWarning?.('desktop floating ball helper not found', {
      hint: 'Build desktop/macos-floating-ball or set LARK_CHANNEL_FLOATING_BALL_HELPER.',
    });
    return false;
  }
  try {
    const child = (input.spawnHelper ?? spawn)(helperPath, ['--root', input.rootDir], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...input.env,
        LARK_CHANNEL_HOME: input.rootDir,
      },
    });
    child.unref();
    return true;
  } catch (err) {
    input.onWarning?.('desktop floating ball helper failed to start', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
