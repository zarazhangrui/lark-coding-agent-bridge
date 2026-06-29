import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export interface LarkChannelCallbackEnvContext {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  policyFingerprint: string;
}

export function buildLarkChannelEnv(
  context?: LarkChannelEnvContext,
  callback?: LarkChannelCallbackEnvContext,
): NodeJS.ProcessEnv {
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

  if (callback) {
    env.LARK_CHANNEL_RUN_ID = callback.runId;
    env.LARK_CHANNEL_SCOPE = callback.scope;
    env.LARK_CHANNEL_CHAT_ID = callback.chatId;
    env.LARK_CHANNEL_OPERATOR_OPEN_ID = callback.operatorOpenId;
    env.LARK_CHANNEL_POLICY_FINGERPRINT = callback.policyFingerprint;
  }

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
