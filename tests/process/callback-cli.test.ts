import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallbackRegistryStore } from '../../src/card/callback-registry';
import { resolveAppPaths } from '../../src/config/app-paths';

const exec = promisify(execFile);
let fixture: string;
let cli: string;
let schemaFile: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'callback-cli-'));
  await symlink(join(process.cwd(), 'node_modules'), join(fixture, 'node_modules'), 'junction');
  await build({
    config: false, entry: { cli: 'src/cli/index.ts' }, outDir: fixture,
    format: 'esm', platform: 'node', target: 'node20', splitting: false, dts: false, silent: true,
    outExtension: () => ({ js: '.mjs' }),
    esbuildOptions(options) { options.loader = { ...options.loader, '.html': 'text' }; },
  });
  cli = join(fixture, 'cli.mjs');
  schemaFile = join(fixture, 'schema.json');
  await writeFile(schemaFile, JSON.stringify({ type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] }));
}, 15000);

afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

function command(args: string[], token?: string) {
  return exec(process.execPath, [cli, 'callback', ...args], {
    env: { ...process.env, LARK_CHANNEL_HOME: fixture, LARK_CHANNEL_PROFILE: 'test', LARK_CHANNEL_CALLBACK_TOKEN: token ?? '' },
    timeout: 10000,
  });
}

describe('callback CLI', () => {
  it('公开命令在活动 run 内登记并绑定回调，输出稳定 JSON；run 结束后不能再登记', async () => {
    const store = new CallbackRegistryStore(join(resolveAppPaths({ rootDir: fixture, profile: 'test' }).profileDir, 'callback-registry.json'));
    const token = await store.beginRun({ runId: 'run-cli', scope: 'oc_chat', chatId: 'oc_chat', operatorOpenId: 'ou_user', policyFingerprint: 'fp-cli', agentId: 'claude' });
    const startedAt = Date.now();
    const { stdout } = await command(['create', '--schema', schemaFile], token);
    const result = JSON.parse(stdout);
    expect(Object.keys(result).sort()).toEqual(['action', 'callback_id', 'expires_at']);
    expect(result.callback_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.action).toBe('agent_callback');
    expect(Date.parse(result.expires_at) - startedAt).toBeGreaterThanOrEqual(3600000);
    expect(Date.parse(result.expires_at) - startedAt).toBeLessThan(3610000);
    const bound = await command(['bind', '--id', result.callback_id, '--message-id', 'om_card'], token);
    expect(JSON.parse(bound.stdout)).toEqual({ callback_id: result.callback_id, message_id: 'om_card' });
    await store.endRun(token);
    await expect(command(['create', '--schema', schemaFile], token)).rejects.toMatchObject({ stderr: expect.stringContaining('活动 agent run') });
  });

  it('多个 CLI 进程同时登记时不会丢失任何 callback', async () => {
    const store = new CallbackRegistryStore(join(resolveAppPaths({ rootDir: fixture, profile: 'test' }).profileDir, 'callback-registry.json'));
    const token = await store.beginRun({ runId: 'run-parallel', scope: 'oc_chat', chatId: 'oc_chat', operatorOpenId: 'ou_user', policyFingerprint: 'fp-cli', agentId: 'claude' });
    const registrations = await Promise.all(Array.from({ length: 4 }, () => command(['create', '--schema', schemaFile], token)));
    const ids = registrations.map(({ stdout }) => JSON.parse(stdout).callback_id as string);
    expect(new Set(ids).size).toBe(4);
    const bindings = await Promise.all(ids.map((id) => command(['bind', '--id', id, '--message-id', 'om_parallel'], token)));
    expect(bindings.map(({ stdout }) => JSON.parse(stdout).message_id)).toEqual(Array(4).fill('om_parallel'));
    await store.endRun(token);
  });

  it('没有活动授权时即使伪造上下文环境变量也不能登记', async () => {
    await expect(command(['create', '--schema', schemaFile], 'forged-token')).rejects.toMatchObject({ stderr: expect.stringContaining('活动 agent run') });
    await expect(command(['create', '--schema', schemaFile])).rejects.toMatchObject({ stderr: expect.stringContaining('活动 agent run') });
  });

  it('其他 run 不可绑定来源 callback，已绑定的消息不能替换', async () => {
    const store = new CallbackRegistryStore(join(resolveAppPaths({ rootDir: fixture, profile: 'test' }).profileDir, 'callback-registry.json'));
    const context = { scope: 'oc_chat', chatId: 'oc_chat', operatorOpenId: 'ou_user', policyFingerprint: 'fp-cli', agentId: 'claude' as const };
    const source = await store.beginRun({ runId: 'source', ...context });
    const other = await store.beginRun({ runId: 'other', ...context });
    const { stdout } = await command(['create', '--schema', schemaFile], source);
    const id = JSON.parse(stdout).callback_id;
    await expect(command(['bind', '--id', id, '--message-id', 'om_card'], other)).rejects.toMatchObject({ stderr: expect.stringContaining('不属于当前 run') });
    await command(['bind', '--id', id, '--message-id', 'om_card'], source);
    await expect(command(['bind', '--id', id, '--message-id', 'om_copy'], source)).rejects.toMatchObject({ stderr: expect.stringContaining('其他消息') });
    await store.endRun(source);
    await store.endRun(other);
  });

  it.each([['--action', 'stop'], ['--ttl-seconds', '0'], ['--ttl-seconds', '86401'], ['--ttl-seconds', '1.5']])(
    '拒绝不支持的 action 或超出边界的 TTL：%s %s', async (flag, value) => {
      await expect(command(['create', '--schema', schemaFile, flag, value], 'unneeded-token')).rejects.toMatchObject({ stderr: expect.stringContaining(flag === '--action' ? '只支持 agent_callback' : 'ttl-seconds') });
    },
  );

  it.each([
    { type: 'object', properties: { cmd: { type: 'string' } } },
    { type: 'object', properties: {}, additionalProperties: true },
    { type: 'object', properties: { choice: { type: 'string', pattern: '^a$' } } },
  ])('拒绝保留字段、额外字段或无法执行的 schema 规则：%j', async (schema) => {
    const invalidFile = join(fixture, 'invalid-schema.json');
    await writeFile(invalidFile, JSON.stringify(schema));
    await expect(command(['create', '--schema', invalidFile], 'unneeded-token')).rejects.toMatchObject({ stderr: expect.stringContaining('schema') });
  });
});
