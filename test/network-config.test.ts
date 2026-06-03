import { describe, expect, it } from 'vitest';
import { shouldBypassProxy } from '../src/bot/network-config';

describe('NO_PROXY matching', () => {
  it('matches suffix entries with a leading dot', () => {
    expect(shouldBypassProxy('open.feishu.cn', '.feishu.cn')).toBe(true);
    expect(shouldBypassProxy('feishu.cn', '.feishu.cn')).toBe(true);
    expect(shouldBypassProxy('open.larksuite.com', '.feishu.cn')).toBe(false);
  });

  it('matches plain domains and subdomains', () => {
    expect(shouldBypassProxy('open.feishu.cn', 'feishu.cn')).toBe(true);
    expect(shouldBypassProxy('open.feishu.cn', 'open.feishu.cn')).toBe(true);
    expect(shouldBypassProxy('notfeishu.cn', 'feishu.cn')).toBe(false);
  });

  it('ignores ports and accepts wildcard', () => {
    expect(shouldBypassProxy('open.feishu.cn:443', 'open.feishu.cn:443')).toBe(true);
    expect(shouldBypassProxy('open.feishu.cn:443', '*')).toBe(true);
  });
});
