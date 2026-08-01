import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MimoAdapter } from '../../src/agent/mimo/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * Real-binary end-to-end test: spawns the actual `mimo` CLI against an
 * isolated MIMOCODE_HOME and verifies the full event contract (system/text/
 * tool_use/final_text/done) plus session continuation.
 *
 * Requires a working mimo install and provider auth on this machine (auth is
 * copied from ~/.local/share/mimocode/auth.json). The suite only runs when a
 * local mimo provider config + auth exist AND NEWAPI_API_KEY is set — CI
 * never satisfies that, so the default run stays hermetic.
 */
const home = process.env.HOME ?? '';
const enabled =
  process.env.NEWAPI_API_KEY !== undefined &&
  existsSync(join(home, '.local/share/mimocode/auth.json')) &&
  existsSync(join(home, '.config/mimocode/mimocode.jsonc'));

describe.skipIf(!enabled)('MimoAdapter real e2e', () => {
  const cleanup: string[] = [];
  const oldHome = process.env.MIMOCODE_HOME;

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.MIMOCODE_HOME;
    } else {
      process.env.MIMOCODE_HOME = oldHome;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function isolatedHome(): Promise<string> {
    const mimoHome = await mkdtemp(join(tmpdir(), 'mimo-e2e-'));
    // mimo reads auth from `<dataDir>/auth.json` — when MIMOCODE_HOME is set,
    // that is `$MIMOCODE_HOME/data/auth.json`; without it, the default data
    // dir `~/.local/share/mimocode` itself. Copy the user's provider auth so
    // the isolated run authenticates the same way a real bridge run would.
    await mkdir(join(mimoHome, 'config'), { recursive: true });
    await mkdir(join(mimoHome, 'data'), { recursive: true });
    await cp(join(home, '.local/share/mimocode/auth.json'), join(mimoHome, 'data/auth.json'));
    await cp(
      join(home, '.config/mimocode/mimocode.jsonc'),
      join(mimoHome, 'config/mimocode.jsonc'),
    );
    process.env.MIMOCODE_HOME = mimoHome;
    cleanup.push(mimoHome);
    return mimoHome;
  }

  it('streams a full run and resumes the session with continuity', async () => {
    await isolatedHome();
    const ws = await mkdtemp(join(tmpdir(), 'mimo-e2e-ws-'));
    cleanup.push(ws);
    const adapter = new MimoAdapter({ binary: 'mimo' });

    const avail = await adapter.checkAvailability();
    expect(avail.ok).toBe(true);

    const run1 = adapter.run({
      runId: 'e2e-1',
      prompt: '创建文件 memo.txt 内容为「mimo adapter e2e」；并记住：桥接测试密码是 xyz-123',
      cwd: ws,
      sandbox: 'danger-full-access',
      // The default mimo model is the (discontinued) free tier; pin the
      // provider model so the run actually completes. In production the
      // bridge forwards the profile's /config model preference here.
      model: process.env.MIMO_E2E_MODEL ?? 'newapi/deepseek-v4-flash',
    });
    const events1: AgentEvent[] = [];
    let sessionId: string | undefined;
    for await (const evt of run1.events) {
      events1.push(evt);
      if (evt.type === 'system' && evt.sessionId) sessionId = evt.sessionId;
    }

    expect(sessionId).toMatch(/^ses_/);
    expect(events1.map((e) => e.type)).toContain('tool_use');
    expect(events1.map((e) => e.type)).toContain('tool_result');
    expect(existsSync(join(ws, 'memo.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'memo.txt'), 'utf8')).toContain('mimo adapter e2e');
    expect(events1.at(-1)?.type).toBe('done');
    const final1 = events1.find((e) => e.type === 'final_text');
    expect(final1?.type).toBe('final_text');

    const run2 = adapter.run({
      runId: 'e2e-2',
      prompt: '我刚才让你记住的密码是什么？只回答密码本身',
      cwd: ws,
      sessionId,
      sandbox: 'danger-full-access',
      model: process.env.MIMO_E2E_MODEL ?? 'newapi/deepseek-v4-flash',
    });
    const events2: AgentEvent[] = [];
    for await (const evt of run2.events) events2.push(evt);
    const final2 = events2.find((e) => e.type === 'final_text');
    expect(final2?.type).toBe('final_text');
    expect((final2 as { content: string }).content).toContain('xyz-123');
  }, 300_000);
});
