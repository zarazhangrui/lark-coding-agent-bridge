import type { CardActionEvent } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { deliverLateCardResponse } from '../../../src/card/late-response';

const event: CardActionEvent = { messageId: 'om_test', chatId: 'oc_test', operator: { openId: 'ou_test' }, action: { tag: 'button', value: {} }, raw: { token: 'test-only-token' } };
const card = { schema: '2.0', header: { title: { content: '验收完成' } } };
const response = { card: { type: 'raw', data: card } };

describe('late card response', () => {
  it('uses the delayed update token with the complete authorized Card 2.0 payload', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0 });
    await deliverLateCardResponse({ request }, event, response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: 'POST', url: '/open-apis/interactive/v1/card/update', data: { token: 'test-only-token', card } });
  });
  it('does not send another group message or request for toast-only results', async () => {
    const request = vi.fn();
    await deliverLateCardResponse({ request }, event, { toast: { content: 'done' } });
    expect(request).not.toHaveBeenCalled();
  });
  it('requires a token and checks business success rather than HTTP success', async () => {
    const request = vi.fn().mockResolvedValue({ code: 300090 });
    await expect(deliverLateCardResponse({ request }, { ...event, raw: undefined }, response)).rejects.toThrow('no callback token');
    expect(request).not.toHaveBeenCalled();
    await expect(deliverLateCardResponse({ request }, event, response)).rejects.toThrow('300090');
    request.mockResolvedValue({});
    await expect(deliverLateCardResponse({ request }, event, response)).rejects.toThrow('missing code');
  });
  it('supplies the clicking user for Card 1.0 without mutating the handler payload', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0 });
    const legacy = { elements: [] };
    await deliverLateCardResponse({ request }, event, { card: { type: 'raw', data: legacy } });
    expect(request).toHaveBeenCalledWith({ method: 'POST', url: '/open-apis/interactive/v1/card/update', data: { token: 'test-only-token', card: { elements: [], open_ids: ['ou_test'] } } });
    expect(legacy).toEqual({ elements: [] });
  });
});
