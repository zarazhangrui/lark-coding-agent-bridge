import { resolveAppPaths } from '../../config/app-paths';
import { CallbackRegistryStore } from '../../card/callback-registry';

export async function runCallbackCreate(opts: {
  action?: string;
  ttlSeconds?: string;
  profile?: string;
}): Promise<void> {
  const runId = requiredEnv('LARK_CHANNEL_RUN_ID');
  const scope = requiredEnv('LARK_CHANNEL_SCOPE');
  const chatId = requiredEnv('LARK_CHANNEL_CHAT_ID');
  const operatorOpenId = requiredEnv('LARK_CHANNEL_OPERATOR_OPEN_ID');
  const policyFingerprint = requiredEnv('LARK_CHANNEL_POLICY_FINGERPRINT');
  const action = nonEmpty(opts.action) ?? 'agent_callback';
  const ttlMs = parseTtlMs(opts.ttlSeconds);
  const paths = resolveAppPaths({
    rootDir: process.env.LARK_CHANNEL_HOME,
    profile: opts.profile ?? process.env.LARK_CHANNEL_PROFILE,
  });
  const store = new CallbackRegistryStore(`${paths.profileDir}/callback-registry.json`);
  const registration = await store.register({
    runId,
    scope,
    chatId,
    operatorOpenId,
    action,
    policyFingerprint,
    ttlMs,
  });
  process.stdout.write(
    `${JSON.stringify({
      callback_id: registration.id,
      action: registration.action,
      expires_at: new Date(registration.expiresAt).toISOString(),
    })}\n`,
  );
}

function requiredEnv(name: string): string {
  const value = nonEmpty(process.env[name]);
  if (!value) {
    throw new Error(`${name} is required; run this command inside an active lark-channel agent run`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTtlMs(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (!value) return 24 * 60 * 60 * 1000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 24 * 60 * 60) {
    throw new Error('--ttl-seconds must be between 1 and 604800');
  }
  return Math.floor(seconds * 1000);
}
