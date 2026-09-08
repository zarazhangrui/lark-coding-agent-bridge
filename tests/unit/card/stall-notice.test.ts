import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  clearStalled,
  initialState,
  markStallTimeout,
  markStalled,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

const running: RunState = {
  ...initialState,
  blocks: [{ kind: 'text', content: '开始处理。', streaming: true }],
  footer: 'tool_running',
};

const cardJson = (state: RunState): string => JSON.stringify(renderCard(state));

describe('stall notice', () => {
  it('names the outstanding tool while the run is still allowed to continue', () => {
    const state = markStalled(running, { minutes: 20, tool: 'Bash' });

    expect(cardJson(state)).toContain('工具 Bash 已 20 分钟无输出');
    expect(renderText(state)).toContain('工具 Bash 已 20 分钟无输出');
  });

  it('keeps the run streaming and the stop button live at the warning stage', () => {
    const card = renderCard(markStalled(running, { minutes: 20, tool: 'Bash' })) as {
      config: { streaming_mode: boolean };
    };

    // Stage one must not look terminal — the run is genuinely still going and
    // the user needs the button to end it themselves.
    expect(card.config.streaming_mode).toBe(true);
    expect(cardJson(markStalled(running, { minutes: 20 }))).toContain('终止');
  });

  it('omits the tool name when more than one is outstanding', () => {
    // Naming one of several would be a guess presented as fact.
    const state = markStalled(running, { minutes: 20 });

    expect(cardJson(state)).toContain('已 20 分钟无输出');
    expect(cardJson(state)).not.toContain('工具 ');
  });

  it('drops the warning once the run proves it is alive', () => {
    const warned = markStalled(running, { minutes: 20, tool: 'Bash' });

    expect(clearStalled(warned).stalled).toBeUndefined();
    expect(cardJson(clearStalled(warned))).not.toContain('无输出');
  });

  it('reports the stall as the reason on the terminal card, not as a user interrupt', () => {
    const state = markStallTimeout(running, { minutes: 30, tool: 'Bash' });

    expect(state.terminal).toBe('stall_timeout');
    const json = cardJson(state);
    expect(json).toContain('工具 Bash 已 30 分钟无输出,已自动终止');
    expect(json).not.toContain('已被中断');
    expect(renderText(state)).toContain('已自动终止');
  });

  it('closes the card out of streaming mode when the watchdog stops the run', () => {
    const card = renderCard(markStallTimeout(running, { minutes: 30 })) as {
      config: { streaming_mode: boolean; summary: { content: string } };
    };

    expect(card.config.streaming_mode).toBe(false);
    // No tool was outstanding, so don't blame one — the same watchdog also
    // bounds a run that went silent without ever calling a tool.
    expect(card.config.summary.content).toBe('无响应');
  });

  it('blames the tool only when one was actually outstanding', () => {
    const withTool = renderCard(markStallTimeout(running, { minutes: 30, tool: 'Bash' })) as {
      config: { summary: { content: string } };
    };
    expect(withTool.config.summary.content).toBe('工具卡死');
  });

  it('summarises a warned-but-running turn distinctly from a killed one', () => {
    const warned = renderCard(markStalled(running, { minutes: 20 })) as {
      config: { summary: { content: string } };
    };

    expect(warned.config.summary.content).toBe('疑似卡住');
  });
});
