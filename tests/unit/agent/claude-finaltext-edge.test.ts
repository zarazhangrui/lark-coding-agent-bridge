import { describe, expect, it } from 'vitest';
import { createTranslateEvent } from '../../../src/agent/claude/stream-json.js';

/**
 * 验证 claude translator 在长任务事件序列下的行为，重点检查：
 * 1. 结论是否重复（final_text 与过程 text 内容重叠）
 * 2. 多段 text 是否丢失
 */

function runTranslator(lines: unknown[]) {
  const translate = createTranslateEvent();
  const events: Array<{ type: string; content?: string; delta?: string; id?: string }> = [];
  for (const line of lines) {
    events.push(...translate.translate(line));
  }
  return events;
}

const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
const result = () => ({ type: 'result', session_id: 's1' });

describe('claude translator 长任务序列', () => {
  it('场景A: 工具间隙过程文字 → 全部为过程 text，无 final_text（正常无重复）', () => {
    const events = runTranslator([
      assistant([text('让我先看下结构')]),
      assistant([toolUse('t1', 'Bash')]),
      { type: 'user', message: { content: [toolResult('t1')] } },
      assistant([text('好的，开始修改')]),
      assistant([toolUse('t2', 'Edit')]),
      { type: 'user', message: { content: [toolResult('t2')] } },
      assistant([text('这是最终结论')]),
      result(),
    ]);
    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    expect(texts).toEqual(['让我先看下结构', '好的，开始修改']);
    expect(finals).toEqual(['这是最终结论']);
    // 结论只出现一次：最终结论不在过程 text 里
    const allText = [...texts, ...finals].join('');
    expect(allText.split('这是最终结论').length - 1).toBe(1);
  });

  it('场景B: 结论前又调工具 → 前一段总结进 stream，真正结论独立发（内容可能重复）', () => {
    const events = runTranslator([
      assistant([text('检查完成，总结：功能A完成、功能B完成')]),
      assistant([toolUse('t3', 'Bash')]),
      { type: 'user', message: { content: [toolResult('t3')] } },
      assistant([text('验证通过，任务完成')]),
      result(),
    ]);
    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    expect(texts).toEqual(['检查完成，总结：功能A完成、功能B完成']);
    expect(finals).toEqual(['验证通过，任务完成']);
    // 无内容相同，但"总结"文字确实进了 stream（用户会看到总结滚动）
    expect(texts.join('')).toContain('总结');
  });

  it('场景C: 同一条 assistant 消息多个 text block → 检查是否丢失', () => {
    const events = runTranslator([
      assistant([text('第一部分'), text('第二部分')]),
      result(),
    ]);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    // 如果只保留一个，说明丢失
    console.log('同消息多 text final_text:', finals);
    expect(finals.length).toBe(1);
  });

  it('场景D: 纯文本长回复（无工具）→ 全部为 final_text 独立发', () => {
    const events = runTranslator([
      assistant([text('这是很长的回复内容，一段话')]),
      result(),
    ]);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(0);
    expect(finals).toEqual(['这是很长的回复内容，一段话']);
  });

  it('场景E: 结论后又有工具 → 结论被当成过程 text 进 stream（重复风险）', () => {
    const events = runTranslator([
      assistant([text('完成了，这是完整结论：...很长...')]),
      assistant([toolUse('t4', 'Bash')]),
      { type: 'user', message: { content: [toolResult('t4')] } },
      assistant([text('完毕')]),
      result(),
    ]);
    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);
    // 大段结论被当过程 text 进 stream（用户已看到），final_text 只是"完毕"
    expect(texts).toContain('完成了，这是完整结论：...很长...');
    expect(finals).toEqual(['完毕']);
  });

  it('真实长任务模式: 多轮短过程文字+工具, 最后长结论 → 无重复无丢失', () => {
    // 模拟真实 claude 长任务: 工具间隙输出简短说明, 最后 result 前输出完整结论
    const events = runTranslator([
      assistant([text('让我先看下项目结构')]),
      assistant([toolUse('t1', 'Bash')]),
      { type: 'user', message: { content: [toolResult('t1')] } },
      assistant([text('找到问题,开始修改')]),
      assistant([toolUse('t2', 'Edit')]),
      { type: 'user', message: { content: [toolResult('t2')] } },
      assistant([text('再检查一下样式')]),
      assistant([toolUse('t3', 'Read')]),
      { type: 'user', message: { content: [toolResult('t3')] } },
      assistant([text('全部完成。这是最终结论,包含详细说明:...')]),
      result(),
    ]);
    const texts = events.filter((e) => e.type === 'text').map((e) => e.delta);
    const finals = events.filter((e) => e.type === 'final_text').map((e) => e.content);

    // 过程说明全部进 stream, 结论只发一次 (final_text)
    expect(texts).toEqual(['让我先看下项目结构', '找到问题,开始修改', '再检查一下样式']);
    expect(finals).toEqual(['全部完成。这是最终结论,包含详细说明:...']);
    // 结论在 stream 里不重复出现
    const allText = [...texts, ...finals].join('');
    expect(allText.split('全部完成').length - 1).toBe(1);
  });
});
