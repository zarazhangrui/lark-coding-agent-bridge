import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter, PiJsonTranslator } from '../../src/agent/pi/adapter';
import { profileCapability } from '../../src/agent/capability';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { formatRootConfig, createRootConfig, loadRootConfig } from '../../src/config/profile-store';
import { SessionCatalog } from '../../src/session/catalog';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fakePi(mode = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-pi-')); dirs.push(dir);
  const binary = join(dir, 'pi');
  await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
let input=''; for await (const chunk of process.stdin) input+=chunk;
writeFileSync(${JSON.stringify(join(dir, 'record.json'))}, JSON.stringify({args: process.argv.slice(2), input}));
const emit = e => process.stdout.write(JSON.stringify(e)+'\\n');
${mode === 'hang' ? "setInterval(()=>{}, 1000);" : mode === 'bad' ? "console.log('invalid protocol');" : `
emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'hello\\u2028world'}});
emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final\\u2028answer'}],stopReason:'stop'}});
emit({type:'agent_end',willRetry:true});
emit({type:'agent_settled',aborted:false});`}
`);
  await chmod(binary, 0o700);
  return { dir, binary, adapter: new PiAdapter({ binary, profileStateDir: dir }) };
}
describe('Pi JSON process adapter', () => {
  it('preserves Unicode separators, uses stdin and resumes the exact isolated UUID', async () => {
    const { dir, adapter } = await fakePi();
    const sessionId = '00ed2a73-559a-4530-b623-07ab84767db2';
    const options = { runId: 'r', prompt: 'write a draft; $(ignored)', cwd: dir, sessionId };
    await adapter.prepareRun(options);
    const run = adapter.run(options);
    const events = []; for await (const event of run.events) events.push(event);
    expect(events).toContainEqual({ type: 'text', delta: 'hello\u2028world' });
    expect(events).toContainEqual({ type: 'final_text', content: 'final\u2028answer' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId, terminationReason: 'normal' });
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'));
    expect(record.args).toEqual(['--mode', 'json', '--session-dir', join(dir, 'pi-sessions'), '--session-id', sessionId]);
    expect(record.input).toContain(options.prompt);
    expect(await run.waitForExit(100)).toBe(true);
  });
  it('rejects unsupported permission reductions and non-UUID resume values', async () => {
    const { dir, adapter } = await fakePi();
    await expect(adapter.prepareRun({ runId: 'r', prompt: '', cwd: dir, sandbox: 'read-only' })).rejects.toThrow('requires full access');
    await expect(adapter.prepareRun({ runId: 'r', prompt: '', cwd: dir, sessionId: '../private' })).rejects.toThrow('exact session UUID');
  });
  it('stops a running process without reporting successful completion', async () => {
    const { dir, adapter } = await fakePi('hang');
    const run = adapter.run({ runId: 'r', prompt: '', cwd: dir, stopGraceMs: 100 });
    const collected = (async () => { const events = []; for await (const e of run.events) events.push(e); return events; })();
    await new Promise(resolve => setTimeout(resolve, 200));
    await run.stop();
    expect((await collected).at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  });
  it('does not finish on low-level agent_end before automatic work settles', () => {
    const translator = new PiJsonTranslator();
    expect([...translator.translate({ type: 'agent_end', willRetry: false })]).toEqual([]);
    expect(translator.settled).toBe(false);
    [...translator.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })];
    expect(translator.error).toBe(true);
    [...translator.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] } })];
    [...translator.translate({ type: 'agent_settled', aborted: false })];
    expect(translator.error).toBe(false);
    expect(translator.finalText).toBe('recovered');
  });
  it('rejects malformed protocol without echoing raw output', async () => {
    const { dir, adapter } = await fakePi('bad');
    const run = adapter.run({ runId: 'r', prompt: '', cwd: dir });
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(JSON.stringify(events)).not.toContain('invalid protocol');
  });
  it('persists Pi profile/session identity and the disabled comment entry', async () => {
    const { dir } = await fakePi();
    const profile = createDefaultProfileConfig({ agentKind: 'pi', accounts: { app: { id: 'test-app', secret: 'test-secret', tenant: 'feishu' } } });
    profile.comments = { enabled: false };
    await writeFile(join(dir, 'config.json'), formatRootConfig(createRootConfig('pi', profile)));
    expect((await loadRootConfig(join(dir, 'config.json')))?.profiles.pi?.comments.enabled).toBe(false);
    expect(profileCapability(profile).agentId).toBe('pi');
    const catalog = new SessionCatalog(join(dir, 'catalog.json'));
    const identity = { agentId: 'pi' as const, scopeId: 'private', cwdRealpath: dir, policyFingerprint: 'policy', sessionId: 'session' };
    catalog.upsertActive(identity); await catalog.flush();
    const reloaded = new SessionCatalog(join(dir, 'catalog.json')); await reloaded.load();
    expect(reloaded.activeFor(identity)?.sessionId).toBe('session');
  });
});
