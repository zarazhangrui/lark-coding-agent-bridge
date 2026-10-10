import { describe, expect, it } from 'vitest';
import { createTranslateEvent } from '../../../src/agent/claude/stream-json.js';

type Ev = { type: string; delta?: string; content?: string; id?: string };

function run(lines: unknown[]): Ev[] {
  const t = createTranslateEvent();
  const out: Ev[] = [];
  for (const l of lines) out.push(...(t.translate(l) as Ev[]));
  return out;
}

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } } });
const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: {} });
const result = () => ({ type: 'result', session_id: 's' });

const textsOf = (evs: Ev[]) => evs.filter((e) => e.type === 'text').map((e) => e.delta ?? '');
const finalsOf = (evs: Ev[]) => evs.filter((e) => e.type === 'final_text').map((e) => e.content ?? '');
const assertNoDup = (arr: string[]) => {
  const m = new Map<string, number>();
  for (const s of arr) m.set(s, (m.get(s) ?? 0) + 1);
  expect([...m.values()].every((c) => c === 1)).toBe(true);
};

describe('claude translator 全面矩阵', () => {
  it('A: 流式多轮 delta+assistant+tool_use（截图场景）→ 无重复', () => {
    const evs = run([
      delta('需求明确'), assistant([text('需求明确')]), assistant([toolUse('t1')]),
      delta('检查环境'), assistant([text('检查环境')]), assistant([toolUse('t2')]),
      delta('最终结论'), assistant([text('最终结论')]),
      result(),
    ]);
    expect(textsOf(evs)).toEqual(['需求明确', '检查环境', '最终结论']);
    expect(finalsOf(evs)).toEqual(['最终结论']);
    assertNoDup(textsOf(evs));
  });

  it('B: 纯流式多段 delta 无工具（长结论）→ 全部流式显示，final 用最后完整块', () => {
    const evs = run([
      delta('第一段'), delta('第二段'), assistant([text('第一段第二段')]),
      result(),
    ]);
    expect(textsOf(evs)).toEqual(['第一段', '第二段']);
    expect(finalsOf(evs)).toEqual(['第一段第二段']);
    assertNoDup(textsOf(evs));
  });

  it('C: 非流式（无 delta）→ 过程 text + final_text', () => {
    const evs = run([
      assistant([text('过程说明')]), assistant([toolUse('t1')]),
      assistant([text('最终结论')]),
      result(),
    ]);
    expect(textsOf(evs)).toEqual(['过程说明']);
    expect(finalsOf(evs)).toEqual(['最终结论']);
    assertNoDup(textsOf(evs));
  });

  it('D: 结论后还有工具调用（场景E）→ 结论当过程，不重复', () => {
    const evs = run([
      delta('大段结论文字'), assistant([text('大段结论文字')]), assistant([toolUse('t1')]),
      assistant([text('完毕')]),
      result(),
    ]);
    // 大段结论已流式显示；"完毕" 是非流式块 → final_text
    expect(textsOf(evs)).toEqual(['大段结论文字']);
    expect(finalsOf(evs)).toEqual(['完毕']);
    assertNoDup(textsOf(evs));
  });

  it('E: 同消息多 text block（非流式）→ 拼接不丢失', () => {
    const evs = run([assistant([text('第一'), text('第二')]), result()]);
    expect(finalsOf(evs)).toEqual(['第一第二']);
  });

  it('F: 流式 + 同消息 text+tool_use 混合', () => {
    const evs = run([
      delta('说明'), assistant([text('说明'), toolUse('t1')]),
      delta('继续'), assistant([text('继续')]),
      result(),
    ]);
    expect(textsOf(evs)).toEqual(['说明', '继续']);
    expect(finalsOf(evs)).toEqual(['继续']);
    assertNoDup(textsOf(evs));
  });

  it('G: 进程无 result 退出 → flushAsText 补发缓冲', () => {
    const t = createTranslateEvent();
    const evs: Ev[] = [];
    evs.push(...(t.translate(assistant([text('失败前内容')])) as Ev[]));
    evs.push(...(t.flushAsText() as Ev[]));
    expect(evs).toEqual([{ type: 'text', delta: '失败前内容' }]);
  });
});
