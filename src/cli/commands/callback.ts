import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CallbackRegistryStore } from '../../card/callback-registry';
import { resolveAppPaths } from '../../config/app-paths';

export async function runCallbackCreate(opts: { schema: string; action?: string; ttlSeconds?: string }): Promise<void> {
  const { store, token } = callbackContext();
  const text = await readFile(opts.schema, 'utf8');
  if (Buffer.byteLength(text) > 16384) throw new Error('callback schema 不得超过 16 KiB');
  const registration = await store.register(token, {
    schema: JSON.parse(text) as unknown,
    action: opts.action,
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: Number(opts.ttlSeconds) } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    callback_id: registration.id,
    action: registration.action,
    expires_at: new Date(registration.expiresAt).toISOString(),
  })}\n`);
}

export async function runCallbackBind(opts: { id: string; messageId: string }): Promise<void> {
  const { store, token } = callbackContext();
  await store.bind(token, opts.id, opts.messageId);
  process.stdout.write(`${JSON.stringify({ callback_id: opts.id, message_id: opts.messageId })}\n`);
}

function callbackContext(): { store: CallbackRegistryStore; token: string } {
  const token = requiredEnv('LARK_CHANNEL_CALLBACK_TOKEN');
  const paths = resolveAppPaths({ rootDir: requiredEnv('LARK_CHANNEL_HOME'), profile: requiredEnv('LARK_CHANNEL_PROFILE') });
  return { store: new CallbackRegistryStore(join(paths.profileDir, 'callback-registry.json')), token };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 缺失，callback 命令仅可在活动 agent run 中执行`);
  return value;
}
