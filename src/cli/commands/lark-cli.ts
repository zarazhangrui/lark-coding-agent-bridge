import { buildLarkChannelEnv } from '../../agent/lark-channel-env';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import { preFlightChecks } from '../preflight';

export interface RunProfileLarkCliOptions {
  config?: string;
  profile?: string;
}

/**
 * Run lark-cli with the selected bridge profile's private credentials and
 * identity policy. This is the supported escape hatch for scripts or a local
 * Codex/Claude session that needs to act as the same bot as the bridge.
 */
export async function runProfileLarkCli(
  args: string[],
  opts: RunProfileLarkCliOptions = {},
): Promise<number> {
  if (args.length === 0) {
    throw new Error('lark-cli arguments are required; add `--` before the lark-cli command');
  }

  const runtime = await resolveProfileRuntime({
    config: opts.config,
    profile: opts.profile,
    allowBootstrap: false,
  });
  const larkChannel = {
    profile: runtime.profile,
    rootDir: runtime.appPaths.rootDir,
    configPath: runtime.configPath,
    larkCliConfigDir: runtime.appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: runtime.appPaths.larkCliSourceConfigFile,
  };

  // Keep the projection and private lark-cli target healthy before executing.
  // This also preserves bot-only policy for team profiles.
  await preFlightChecks({
    bridgeConfig: runtime.cfg,
    profileConfig: runtime.profileConfig,
    appPaths: runtime.appPaths,
    larkChannel,
  });

  const env = mergeProcessEnv(process.env, buildLarkChannelEnv(larkChannel));
  return new Promise<number>((resolve, reject) => {
    const child = spawnProcess('lark-cli', args, {
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(new Error(`lark-cli terminated by signal ${signal ?? 'unknown'}`));
    });
  });
}
