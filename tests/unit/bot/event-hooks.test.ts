import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { installEventHookHandlers } from '../../../src/bot/event-hooks.js';

describe('event hook dispatcher registration', () => {
  it('preserves the real SDK app_ticket handler while installing custom handlers', () => {
    const channel = createLarkChannel({ appId: 'cli_test', appSecret: 'secret' });
    const internals = channel as unknown as {
      dispatcher: { handles: Map<string, RawHandler> };
      registerDispatcherHandlers(): void;
    };
    const appTicketHandler = internals.dispatcher.handles.get('app_ticket');

    installEventHookHandlers(channel, {
      handlers: {
        app_ticket: vi.fn(),
        'custom.available.event_v1': vi.fn(),
      },
    }, { version: 'test' });

    internals.registerDispatcherHandlers();

    expect(appTicketHandler).toEqual(expect.any(Function));
    expect(internals.dispatcher.handles.get('app_ticket')).toBe(appTicketHandler);
    expect(internals.dispatcher.handles.has('im.message.receive_v1')).toBe(true);
    expect(internals.dispatcher.handles.has('custom.available.event_v1')).toBe(true);
  });

  it('registers custom handlers after channel handlers and before event delivery', async () => {
    const channel = fakeChannel({
      'im.message.receive_v1': vi.fn(),
    });
    const handler = vi.fn();

    installEventHookHandlers(channel as unknown as LarkChannel, {
      handlers: {
        'im.chat.member.user.deleted_v1': handler,
      },
    }, {
      version: 'test',
      appId: 'cli_test',
      tenant: 'feishu',
      profile: 'default',
      configPath: '/tmp/config.json',
    });

    expect(channel.dispatcher.handles.has('im.chat.member.user.deleted_v1')).toBe(false);
    channel.registerDispatcherHandlers();
    expect(channel.dispatcher.handles.has('im.message.receive_v1')).toBe(true);

    const installed = channel.dispatcher.handles.get('im.chat.member.user.deleted_v1');
    expect(installed).toEqual(expect.any(Function));

    const event = {
      chat_id: 'oc_chat',
      users: [{ user_id: { open_id: 'ou_left' } }],
    };
    await installed?.(event);

    expect(handler).toHaveBeenCalledWith(event, expect.objectContaining({
      eventType: 'im.chat.member.user.deleted_v1',
      channel,
      appId: 'cli_test',
      tenant: 'feishu',
      profile: 'default',
      configPath: '/tmp/config.json',
    }));
  });

  it('rejects app_ticket and every channel-owned event from the live registry', () => {
    const appTicketHandler = vi.fn();
    const futureBuiltInHandler = vi.fn();
    const channel = fakeChannel({
      'future.channel.event_v1': futureBuiltInHandler,
    }, appTicketHandler);

    installEventHookHandlers(channel as unknown as LarkChannel, {
      handlers: {
        app_ticket: vi.fn(),
        'future.channel.event_v1': vi.fn(),
        'custom.available.event_v1': vi.fn(),
      },
    }, { version: 'test' });

    channel.registerDispatcherHandlers();

    expect(channel.dispatcher.handles.get('app_ticket')).toBe(appTicketHandler);
    expect(channel.dispatcher.handles.get('future.channel.event_v1')).toBe(
      futureBuiltInHandler,
    );
    expect(channel.dispatcher.handles.get('custom.available.event_v1')).toEqual(
      expect.any(Function),
    );
  });

  it('contains hook failures and keeps the dispatcher alive', async () => {
    const channel = fakeChannel();

    installEventHookHandlers(channel as unknown as LarkChannel, {
      handlers: {
        'im.chat.member.user.deleted_v1': () => {
          throw new Error('hook boom');
        },
      },
    }, { version: 'test' });

    channel.registerDispatcherHandlers();
    await expect(
      channel.dispatcher.handles.get('im.chat.member.user.deleted_v1')?.({
        chat_id: 'oc_chat',
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the private channel hook point is unavailable', () => {
    const appTicketHandler = vi.fn();
    const customHandler = vi.fn();
    const channel = {
      dispatcher: {
        handles: new Map([['app_ticket', appTicketHandler]]),
        register: vi.fn(),
      },
    } as unknown as LarkChannel;

    installEventHookHandlers(channel, {
      handlers: { 'custom.event_v1': customHandler },
    }, { version: 'test' });

    expect((channel as unknown as {
      dispatcher: { register: ReturnType<typeof vi.fn> };
    }).dispatcher.register).not.toHaveBeenCalled();
  });
});

type RawHandler = (event: unknown) => Promise<void> | void;

interface FakeHookableChannel {
  dispatcher: {
    handles: Map<string, RawHandler>;
    register(handles: Record<string, RawHandler>): void;
  };
  registerDispatcherHandlers(): void;
}

function fakeChannel(
  channelHandlers: Record<string, RawHandler> = {},
  appTicketHandler: RawHandler = vi.fn(),
): FakeHookableChannel {
  const handles = new Map<string, RawHandler>([['app_ticket', appTicketHandler]]);
  return {
    dispatcher: {
      handles,
      register(next) {
        for (const [eventType, handler] of Object.entries(next)) {
          handles.set(eventType, handler);
        }
      },
    },
    registerDispatcherHandlers() {
      this.dispatcher.register(channelHandlers);
    },
  };
}
