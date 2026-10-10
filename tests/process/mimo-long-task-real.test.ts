import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MimoAdapter } from '../../src/agent/mimo/adapter.js';

/**
 * 真实 mimo 长任务实测（多工具调用），验证是否出现整句重复。
 * 用本机 mimo CLI + 本机 auth（隔离 MIMOCODE_HOME 到临时目录）。
 */
const home = process.env.HOME ?? '';
const enabled = existsSync(join(home, '.local/share/mimocode/auth.json'));

describe.skipIf(!enabled)('MimoAdapter real long task (multi-tool)', () => {
  const cleanups: string[] = [];
  const oldHome = process.env.MIMOCODE_HOME;

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.MIMOCODE_HOME;
    else process.env.MIMOCODE_HOME = oldHome;
    for (const d of cleanups.splice(0)) {
      const { rm } = await import('node:fs/promises');
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('long task: multiple tool calls, no duplicated text, correct final', async () => {
    // 隔离 mimo home（复用本机 auth）
    const mimoHome = mkdtempSync(join(tmpdir(), 'mimo-long-'));
    mkdirSync(join(mimoHome, 'config'), { recursive: true });
    mkdirSync(join(mimoHome, 'data'), { recursive: true });
    const { cpSync } = await import('node:fs');
    if (existsSync(join(home, '.local/share/mimocode/auth.json'))) {
      cpSync(join(home, '.local/share/mimocode/auth.json'), join(mimoHome, 'data/auth.json'));
    }
    if (existsSync(join(home, '.config/mimocode/mimocode.jsonc'))) {
      cpSync(join(home, '.config/mimocode/mimocode.jsonc'), join(mimoHome, 'config/mimocode.jsonc'));
    }
    process.env.MIMOCODE_HOME = mimoHome;
    cleanups.push(mimoHome);

    // 工作区
    const ws = mkdtempSync(join(tmpdir(), 'mimo-long-ws-'));
    cleanups.push(ws);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(ws, 'sample.txt'), 'hello world\nsecond line\nthird line\n');

    const run = new MimoAdapter({ binary: '/home/luoke/.mimocode/bin/mimo' }).run({
      runId: 'mimo-real-long',
      prompt: [
        '在 ' + ws + ' 目录下完成以下任务：',
        '1. 先读取 sample.txt 的内容',
        '2. 创建一个新文件 result.txt，写入"任务完成"和 sample.txt 的行数',
        '3. 修改 result.txt 追加一行"验证通过"',
        '4. 最后用 cat 验证 result.txt 内容',
        '完成后用两三句话总结你做了什么。',
      ].join('\n'),
      cwd: ws,
      sandbox: 'danger-full-access',
      // Pin the provider model (default free tier is discontinued; bridge
      // forwards the profile /config preference in production).
      model: process.env.MIMO_E2E_MODEL ?? 'newapi/deepseek-v4-flash',
    });

    const events = [];
    for await (const ev of run.events) events.push(ev);

    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    const tools = events.filter((e) => e.type === 'tool_use').map((e) => e.name);
    const done = events.filter((e) => e.type === 'done').length;
    const errors = events.filter((e) => e.type === 'error');

    console.log('TOOLS:', JSON.stringify(tools));
    console.log('TEXT_EVENTS:', texts.length, '=>', JSON.stringify(texts.slice(0, 30)));
    console.log('FINAL:', JSON.stringify(finals));
    console.log('DONE:', done, 'ERRORS:', errors.length);

    // 工具调用必须发生（长任务特征）
    expect(tools.length).toBeGreaterThanOrEqual(1);
    // 无 ≥15 字符的完整句子重复（截图 bug 级别）
    const counts = new Map<string, number>();
    for (const t of texts) {
      if (t.length >= 15) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const dups = [...counts.entries()].filter(([, c]) => c > 1);
    console.log('DUPS(>=15chars):', JSON.stringify(dups));
    expect(dups).toEqual([]);
    // 结论存在且含任务关键词
    expect(finals.length).toBeGreaterThan(0);
    expect(finals.join('')).toContain('任务完成');
    expect(done).toBe(1);
    expect(errors).toHaveLength(0);
  }, 300_000);
});
