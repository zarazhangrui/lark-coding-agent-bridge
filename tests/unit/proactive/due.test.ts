import { describe, expect, it } from 'vitest';
import {
  formatDueAt,
  parseExplicitDueAt,
  parsePostponeDueAt,
} from '../../../src/proactive/due';

describe('explicit due parser', () => {
  const timeZone = 'Asia/Shanghai';
  const now = Date.parse('2026-10-09T02:30:00.000Z'); // 2026-10-09 10:30 in Shanghai

  it('parses explicit relative dates and rejects messages without a date', () => {
    expect(parseExplicitDueAt('我明天把报告发出来', now, timeZone)).toBe(
      Date.parse('2026-10-10T10:00:00.000Z'),
    );
    expect(parseExplicitDueAt('这个三天后再跟进', now, timeZone)).toBe(
      Date.parse('2026-10-12T10:00:00.000Z'),
    );
    expect(parseExplicitDueAt('我晚点把报告发出来', now, timeZone)).toBeUndefined();
  });

  it('parses short relative minute and hour deadlines from the message timestamp', () => {
    expect(
      parseExplicitDueAt('我需要在 3 分钟后完成主动式智能体验收', now, timeZone),
    ).toBe(now + 3 * 60 * 1_000);
    expect(parseExplicitDueAt('半小时后提醒我提交反馈', now, timeZone)).toBe(
      now + 30 * 60 * 1_000,
    );
    expect(parseExplicitDueAt('两个小时后跟进候选人', now, timeZone)).toBe(
      now + 2 * 60 * 60 * 1_000,
    );
    expect(parseExplicitDueAt('2 个小时后跟进候选人', now, timeZone)).toBe(
      now + 2 * 60 * 60 * 1_000,
    );
  });

  it('accepts a bare relative duration only for an already-classified postpone action', () => {
    expect(parseExplicitDueAt('改到 5 分钟吧', now, timeZone)).toBeUndefined();
    expect(parsePostponeDueAt('改到 5 分钟吧', now, timeZone)).toBe(now + 5 * 60_000);
    expect(parsePostponeDueAt('延后半小时', now, timeZone)).toBe(now + 30 * 60_000);
    expect(parsePostponeDueAt('推迟两个小时', now, timeZone)).toBe(now + 2 * 60 * 60_000);
  });

  it('parses explicit clock times in the configured zone rather than the host timezone', () => {
    const dueAt = parseExplicitDueAt('我明天下午 3 点前把反馈发群里', now, timeZone);
    expect(dueAt).toBe(Date.parse('2026-10-10T07:00:00.000Z'));
    expect(formatDueAt(dueAt!, timeZone)).toMatch(/10\/10.*15:00/);
  });

  it('parses absolute dates and rejects impossible calendar dates', () => {
    expect(parseExplicitDueAt('截止 2026-10-15 14:30', now, timeZone)).toBe(
      Date.parse('2026-10-15T06:30:00.000Z'),
    );
    expect(parseExplicitDueAt('2026-02-30 交付', now, timeZone)).toBeUndefined();
  });

  it('interprets 下周 as the next calendar week', () => {
    expect(parseExplicitDueAt('下周一下午 2 点交周报', now, timeZone)).toBe(
      Date.parse('2026-10-12T06:00:00.000Z'),
    );
  });
});

