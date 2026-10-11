import { describe, expect, it, vi } from 'vitest';
import { proactiveChannel } from '../../../src/proactive/channel';

describe('checked proactive card updates', () => {
  it.each([{ code: 230002 }, {}, undefined])('rejects an unsuccessful/unknown patch: %j', async (result) => {
    const request = vi.fn(async () => result);
    const channel = proactiveChannel({ send: vi.fn(), rawClient: { request } } as never);
    await expect(channel.updateCard('om_test', { schema: '2.0' })).rejects.toThrow('not confirmed');
    expect(request).toHaveBeenCalledOnce();
  });
  it('patches the exact message and accepts explicit platform success', async () => {
    const request = vi.fn(async () => ({ code: 0 }));
    const channel = proactiveChannel({ send: vi.fn(), rawClient: { request } } as never);
    await expect(channel.updateCard('om_test', { schema: '2.0' })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({ method: 'PATCH', url: '/open-apis/im/v1/messages/om_test', data: { content: '{"schema":"2.0"}' } });
  });
});
