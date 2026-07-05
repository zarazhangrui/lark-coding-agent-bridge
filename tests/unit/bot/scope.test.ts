import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { isThreadedScope, scopeForMessage } from '../../../src/bot/scope.js';

describe('scopeForMessage', () => {
  it('uses thread_id as its own scope even in plain groups', () => {
    const msg = {
      chatId: 'oc_group',
      threadId: 'omt_thread',
    } as NormalizedMessage;

    expect(scopeForMessage(msg)).toBe('oc_group:omt_thread');
  });
});

describe('isThreadedScope', () => {
  it('tracks the same signal Feishu puts on threaded messages', () => {
    expect(isThreadedScope('omt_thread')).toBe(true);
    expect(isThreadedScope(undefined)).toBe(false);
  });
});
