import { describe, expect, it } from 'vitest';
import { buildBridgeThreadName } from '../../../src/bot/thread-name.js';

describe('buildBridgeThreadName', () => {
  it('collapses whitespace and keeps the visible user text', () => {
    expect(buildBridgeThreadName('飞书', '  帮我\n\n检查   这个项目  ')).toBe(
      '飞书 · 帮我 检查 这个项目',
    );
  });

  it('uses a readable fallback and truncates by Unicode characters', () => {
    expect(buildBridgeThreadName('飞书评论', '   ')).toBe('飞书评论 · 新会话');
    const title = buildBridgeThreadName('飞书', '测'.repeat(200));
    expect(Array.from(title)).toHaveLength(96);
    expect(title.endsWith('…')).toBe(true);
  });
});
