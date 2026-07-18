import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
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

  // When LARK_CHANNEL_HOME is set, explicitly clear HERMES_HOME and
  // OPENCLAW_HOME so that lark-cli's auto-detection picks up the
  // lark-channel source instead of hermes/openclaw. Without this,
  // a HERMES_HOME inherited from the outer environment takes
  // precedence, causing lark-cli to bind to the wrong workspace/app.
  if (rootDir) {
    env.HERMES_HOME = undefined;
    env.OPENCLAW_HOME = undefined;
  }

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
