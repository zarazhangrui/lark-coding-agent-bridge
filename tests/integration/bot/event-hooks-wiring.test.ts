import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { startChannel } from '../../../src/bot/channel.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

interface FakeLarkChannel {
  registered: Record<string, (event: unknown) => Promise<void> | void>;
  phases: string[];
  dispatcher: {
    handles: Map<string, (event: unknown) => Promise<void> | void>;
    register: ReturnType<typeof vi.fn>;
  };
  registerDispatcherHandlers: ReturnType<typeof vi.fn>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('event hook channel wiring', () => {
  it('registers custom hooks after channel handlers and before WebSocket startup', async () => {
    const { channel, deps } = await createHarness();
    const close = vi.fn(() => {
      channel.phases.push('hook:close');
    });

    const bridge = await startChannel({
      ...deps,
      eventHooks: {
        handlers: {
          'im.chat.member.user.deleted_v1': vi.fn(),
        },
        close,
      },
      eventHookMeta: { version: 'test' },
    });

    expect(channel.connect).toHaveBeenCalled();
    expect(channel.phases).toEqual([
      'connect:start',
      'channel:register',
      'hook:register',
      'websocket:start',
    ]);
    expect(channel.dispatcher.handles.has('app_ticket')).toBe(true);
    expect(channel.dispatcher.handles.has('im.message.receive_v1')).toBe(true);
    expect(channel.dispatcher.handles.has('im.chat.member.user.deleted_v1')).toBe(true);

    await bridge.disconnect();
    expect(channel.phases.slice(-2)).toEqual(['websocket:stop', 'hook:close']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the hook when channel startup fails', async () => {
    const { channel, deps } = await createHarness();
    const close = vi.fn(() => {
      channel.phases.push('hook:close');
    });
    channel.connect.mockImplementationOnce(async () => {
      channel.phases.push('connect:start');
      throw new Error('connect failed');
    });

    await expect(startChannel({
      ...deps,
      eventHooks: {
        handlers: { 'custom.event_v1': vi.fn() },
        close,
      },
      eventHookMeta: { version: 'test' },
    })).rejects.toThrow('connect failed');

    expect(channel.disconnect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(channel.phases).toEqual([
      'connect:start',
      'websocket:stop',
      'hook:close',
    ]);
  });

  it('contains a synchronous hook close failure during normal shutdown', async () => {
    const { channel, deps } = await createHarness();
    const sessionsFlush = vi.spyOn(deps.sessions, 'flush');
    const workspacesFlush = vi.spyOn(deps.workspaces, 'flush');
    const close = vi.fn(() => {
      channel.phases.push('hook:close');
      throw new Error('close failed');
    });

    const bridge = await startChannel({
      ...deps,
      eventHooks: { handlers: {}, close },
      eventHookMeta: { version: 'test' },
    });

    await expect(bridge.disconnect()).resolves.toBeUndefined();
    expect(channel.disconnect).toHaveBeenCalledTimes(1);
    expect(sessionsFlush).toHaveBeenCalledTimes(1);
    expect(workspacesFlush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(channel.phases.slice(-2)).toEqual(['websocket:stop', 'hook:close']);
  });
});

async function createHarness(): Promise<{
  channel: FakeLarkChannel;
  deps: Parameters<typeof startChannel>[0];
}> {
  const tmp = await createTmpProfile('event-hooks-wiring-');
  cleanups.push(tmp.cleanup);
  const workspace = await realpath(tmp.workspace);
  const baseCfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
  });
  const cfg = {
    ...baseCfg,
    workspaces: {
      ...baseCfg.workspaces,
      default: workspace,
    },
  };
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  return {
    channel,
    deps: {
      cfg,
      agent: new FakeAgentAdapter(),
      sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
      workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
      controls: {
        profile: 'test',
        profileConfig: cfg,
        ownerRefreshState: 'unknown',
        async refreshOwner() {},
        async restart() {},
        async exit() {},
        configPath: '/tmp/config.json',
        cfg,
        processId: 'proc_test',
      },
    },
  };
}

function createFakeLarkChannel(): FakeLarkChannel {
  const registered: Record<string, (event: unknown) => Promise<void> | void> = {};
  const phases: string[] = [];
  const appTicketHandler = vi.fn();
  const handles = new Map<string, (event: unknown) => Promise<void> | void>([
    ['app_ticket', appTicketHandler],
  ]);
  const channel = {
    registered,
    phases,
    dispatcher: {
      handles,
      register: vi.fn((next: Record<string, (event: unknown) => Promise<void> | void>) => {
        const eventTypes = Object.keys(next);
        phases.push(eventTypes.includes('im.message.receive_v1')
          ? 'channel:register'
          : 'hook:register');
        Object.assign(registered, next);
        for (const [eventType, handler] of Object.entries(next)) {
          channel.dispatcher.handles.set(eventType, handler);
        }
      }),
    },
    registerDispatcherHandlers: vi.fn(() => {
      channel.dispatcher.register({
        'im.message.receive_v1': vi.fn(),
      });
    }),
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    on: vi.fn(),
    connect: vi.fn(async () => {
      phases.push('connect:start');
      channel.registerDispatcherHandlers();
      phases.push('websocket:start');
    }),
    disconnect: vi.fn(async () => {
      phases.push('websocket:stop');
    }),
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
  } as unknown as FakeLarkChannel;
  return channel;
}
