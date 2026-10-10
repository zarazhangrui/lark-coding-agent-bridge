import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';

/**
 * 真实长任务实测：让 claude 执行多次工具调用（读文件 → 创建新文件 →
 * 修改 → 验证），经完整 adapter 链路（--include-partial-messages 流式），
 * 断言 text 事件无重复、final_text 正确、工具调用完整。
 */
describe('ClaudeAdapter real long task (multi-tool, streaming)', () => {
  it('long task: multiple tool calls, no duplicated text, correct final', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'claude-long-task-'));
    try {
      writeFileSync(join(ws, 'sample.txt'), 'hello world\nsecond line\nthird line\n');
      const run = new ClaudeAdapter({ binary: 'claude' }).run({
        runId: 'real-long-task',
        prompt: [
          `在 ${ws} 目录下完成以下任务：`,
          '1. 先读取 sample.txt 的内容',
          '2. 创建一个新文件 result.txt，写入"任务完成"和 sample.txt 的行数',
          '3. 修改 result.txt 追加一行"验证通过"',
          '4. 最后用 cat 验证 result.txt 内容',
          '完成后用两三句话总结你做了什么。',
        ].join('\n'),
        cwd: ws,
        permissionMode: 'bypassPermissions',
      });

      const events = [];
      for await (const ev of run.events) events.push(ev);

      const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
      const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
      const tools = events.filter((e) => e.type === 'tool_use').map((e) => e.name);
      const done = events.filter((e) => e.type === 'done').length;
      const errors = events.filter((e) => e.type === 'error');

      console.log('TOOLS:', JSON.stringify(tools));
      console.log('TEXT_EVENTS:', texts.length, '=>', JSON.stringify(texts.slice(0, 40)));
      console.log('FINAL:', JSON.stringify(finals));
      console.log('DONE:', done, 'ERRORS:', errors.length);

      // 工具调用必须发生（长任务特征）
      expect(tools.length).toBeGreaterThanOrEqual(2);
      // 无实质重复：流式增量是碎片化的（文件名、常用词多次出现正常），但
      // 不应有 ≥15 字符的完整句子/短语重复。截图 bug 是整句重复。
      const counts = new Map<string, number>();
      for (const t of texts) {
        if (t.length >= 15) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const dups = [...counts.entries()].filter(([, c]) => c > 1);
      console.log('DUPS(>=15chars):', JSON.stringify(dups));
      expect(dups).toEqual([]);
      // 最终结论存在且非空、包含任务关键词（不是碎片）
      expect(finals.length).toBeGreaterThan(0);
      expect(finals.join('')).toContain('任务完成');
      expect(finals.join('')).toContain('验证通过');
      expect(done).toBe(1);
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);
});
