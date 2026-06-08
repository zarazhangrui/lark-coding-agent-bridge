import { describe, expect, it } from 'vitest';
import { normalizeAtMentions } from '../../../src/bot/channel.js';

describe('normalizeAtMentions', () => {
  it('rewrites the canonical card form to the post form', () => {
    const r = normalizeAtMentions('hi <at id="ou_abc"></at> there');
    expect(r.found).toBe(true);
    expect(r.text).toBe('hi <at user_id="ou_abc"></at> there');
  });

  it('handles the loose form the agent tends to write (no quotes + inner text)', () => {
    const r = normalizeAtMentions('<at id=ou_9ec0d0>二娃</at> 在吗');
    expect(r.found).toBe(true);
    expect(r.text).toBe('<at user_id="ou_9ec0d0"></at> 在吗');
  });

  it('accepts user_id and open_id attributes too', () => {
    expect(normalizeAtMentions('<at user_id="ou_x">n</at>').text).toBe('<at user_id="ou_x"></at>');
    expect(normalizeAtMentions('<at open_id=ou_y>n</at>').text).toBe('<at user_id="ou_y"></at>');
  });

  it('rewrites every mention in the text', () => {
    const r = normalizeAtMentions('<at id=ou_a>A</at> 和 <at id="ou_b">B</at> 你们好');
    expect(r.found).toBe(true);
    expect(r.text).toBe('<at user_id="ou_a"></at> 和 <at user_id="ou_b"></at> 你们好');
  });

  it('leaves text without mentions untouched and reports not found', () => {
    const r = normalizeAtMentions('普通回复，**加粗**，没有 @ 任何人');
    expect(r.found).toBe(false);
    expect(r.text).toBe('普通回复，**加粗**，没有 @ 任何人');
  });

  it('does not touch a literal "@name" with no <at> tag (can\'t resolve an id)', () => {
    const r = normalizeAtMentions('@二娃 你好');
    expect(r.found).toBe(false);
    expect(r.text).toBe('@二娃 你好');
  });
});
