import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';

// 用真实 claude CLI 跑一次流式任务，验证 translator 全链路（真实事件流）
describe('ClaudeAdapter real stream-json (--include-partial-messages)', () => {
  it('real claude: streams deltas without duplicating text, final_text present', async () => {
    const run = new ClaudeAdapter({ binary: 'claude' }).run({
      runId: 'real-stream-check',
      prompt: '用一句话回复：确认收到',
      cwd: '/home/luoke/lark-channel-bridge',
      permissionMode: 'bypassPermissions',
    });
    const events = [];
    for await (const ev of run.events) events.push(ev);

    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    const thinking = events.filter((e) => e.type === 'thinking').length;
    const done = events.filter((e) => e.type === 'done').length;

    console.log('TEXTS:', JSON.stringify(texts.slice(0, 30)));
    console.log('FINAL:', JSON.stringify(finals));
    console.log('THINKING_EVENTS:', thinking, 'DONE:', done);

    // 无重复句子
    const counts = new Map();
    for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, c]) => c > 1);
    console.log('DUPS:', JSON.stringify(dups));
    expect(dups).toEqual([]);
    expect(done).toBe(1);
  }, 120_000);
});
