import { describe, expect, it, vi } from 'vitest';
import {
  addBotToChat,
  completeDeviceLogin,
  getUserAuthStatus,
  listUserChats,
  searchUserChats,
  startDeviceLogin,
  type LarkCliExec,
} from '../../../src/lark-cli/user-im';

const ctx = { profile: 'claude', rootDir: '/tmp/lark-home' };

/** Build a stub exec that returns canned output based on the args. */
function stub(map: (args: string[]) => { code?: number; stdout?: string; stderr?: string }): LarkCliExec {
  return vi.fn(async (args: string[]) => ({
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...map(args),
  }));
}

describe('user-im lark-cli helpers', () => {
  it('parses auth status (logged-in user + scopes)', async () => {
    const exec = stub(() => ({
      stdout: JSON.stringify({
        appId: 'cli_x',
        identities: {
          bot: { status: 'ready', available: true },
          user: {
            status: 'ready',
            available: true,
            tokenStatus: 'valid',
            userName: '马哲',
            openId: 'ou_abc',
            scope: 'im:chat:read im:chat.members:write_only im:message',
          },
        },
        identity: 'user',
      }),
    }));
    const status = await getUserAuthStatus(ctx, exec);
    expect(status.loggedIn).toBe(true);
    expect(status.userName).toBe('马哲');
    expect(status.openId).toBe('ou_abc');
    expect(status.scopes).toContain('im:chat.members:write_only');
  });

  it('reports not-logged-in when the user identity is unavailable', async () => {
    const exec = stub(() => ({
      stdout: JSON.stringify({ identities: { user: { status: 'not_authorized', available: false } } }),
    }));
    const status = await getUserAuthStatus(ctx, exec);
    expect(status.loggedIn).toBe(false);
    expect(status.scopes).toEqual([]);
  });

  it('starts the device flow with explicit --scope (never --domain im) and extracts URL + code', async () => {
    const exec = stub((args) => {
      // Must request specific scopes, not the whole im domain (which pulls in
      // im:message.send_as_user and fails).
      expect(args).toContain('--scope');
      expect(args).not.toContain('--domain');
      expect(args.join(' ')).toContain('im:chat:read');
      return {
        stdout: JSON.stringify({
          verification_uri_complete: 'https://open.feishu.cn/verify?code=ABCD',
          user_code: 'ABCD',
          device_code: 'dev-123',
          expires_in: 300,
        }),
      };
    });
    const dl = await startDeviceLogin(ctx, ['im:chat:read'], exec);
    expect(dl.verificationUrl).toContain('open.feishu.cn');
    expect(dl.deviceCode).toBe('dev-123');
    expect(dl.userCode).toBe('ABCD');
    expect(dl.expiresIn).toBe(300);
  });

  it('throws a clear error when device login yields no URL', async () => {
    const exec = stub(() => ({ code: 1, stderr: 'app not bound' }));
    await expect(startDeviceLogin(ctx, ['im:chat:read'], exec)).rejects.toThrow(/app not bound|验证链接/);
  });

  it('completes device login (ok on exit 0, error otherwise)', async () => {
    const okExec = stub(() => ({ code: 0, stdout: '{"ok":true}' }));
    expect(await completeDeviceLogin(ctx, 'dev-123', okExec)).toEqual({ ok: true });

    const pendingExec = stub(() => ({ code: 1, stdout: JSON.stringify({ message: 'authorization_pending' }) }));
    const r = await completeDeviceLogin(ctx, 'dev-123', pendingExec);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('authorization_pending');
  });

  it('lists the user chats (page of 8) with pagination token from data.has_more/page_token', async () => {
    const exec = stub((args) => {
      expect(args).toContain('--as');
      expect(args).toContain('user');
      expect(args).toContain('--page-size');
      expect(args[args.indexOf('--page-size') + 1]).toBe('8');
      // Mirror lark-cli's actual `im +chat-list` output shape.
      return {
        stdout: JSON.stringify({
          ok: true,
          identity: 'user',
          data: {
            has_more: true,
            page_token: 'tok-2',
            chats: [
              { chat_id: 'oc_1', name: '产品群', chat_mode: 'group' },
              { chat_id: 'oc_2', name: '' },
              { id: 'oc_3', name: '技术群' },
            ],
          },
        }),
      };
    });
    const page = await listUserChats(ctx, {}, exec);
    expect(page.chats).toEqual([
      { id: 'oc_1', name: '产品群' },
      { id: 'oc_2', name: '(无名群)' },
      { id: 'oc_3', name: '技术群' },
    ]);
    expect(page.nextPageToken).toBe('tok-2');
  });

  it('has no nextPageToken when has_more is false, and forwards --page-token', async () => {
    const exec = stub((args) => {
      expect(args).toContain('--page-token');
      expect(args[args.indexOf('--page-token') + 1]).toBe('tok-2');
      return { stdout: JSON.stringify({ data: { has_more: false, page_token: '', chats: [{ chat_id: 'oc_9', name: 'g' }] } }) };
    });
    const page = await listUserChats(ctx, { pageToken: 'tok-2' }, exec);
    expect(page.chats).toEqual([{ id: 'oc_9', name: 'g' }]);
    expect(page.nextPageToken).toBeUndefined();
  });

  it('searches the user chats by query via +chat-search', async () => {
    const exec = stub((args) => {
      expect(args).toContain('+chat-search');
      expect(args).toContain('--query');
      expect(args[args.indexOf('--query') + 1]).toBe('产品');
      expect(args).toContain('--as');
      expect(args).toContain('user');
      return { stdout: JSON.stringify({ data: { chats: [{ chat_id: 'oc_p', name: '产品群' }] } }) };
    });
    const page = await searchUserChats(ctx, { query: '产品' }, exec);
    expect(page.chats).toEqual([{ id: 'oc_p', name: '产品群' }]);
  });

  it('adds the bot to a chat with member-id-type app_id (no --yes flag)', async () => {
    const exec = stub((args) => {
      expect(args).toContain('--member-id-type');
      expect(args).toContain('app_id');
      expect(args.join(' ')).toContain('cli_bot');
      // chat.members create is a plain write — it rejects --yes.
      expect(args).not.toContain('--yes');
      return { stdout: JSON.stringify({ data: {} }) };
    });
    const r = await addBotToChat(ctx, 'oc_1', 'cli_bot', exec);
    expect(r).toEqual({ ok: true, pending: false });
  });

  it('surfaces lark-cli validation errors cleanly (from stderr JSON), not the raw blob', async () => {
    const exec = stub(() => ({
      code: 1,
      stderr: JSON.stringify({
        ok: false,
        error: { type: 'validation', message: 'unknown flag "--yes"' },
        _notice: { update: { message: 'lark-cli 1.0.73 available' } },
      }),
    }));
    const r = await addBotToChat(ctx, 'oc_1', 'cli_bot', exec);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown flag');
    expect(r.message).not.toContain('_notice');
  });

  it('reports pending when the group needs owner/admin approval', async () => {
    const exec = stub(() => ({
      stdout: JSON.stringify({ data: { pending_approval_id_list: ['cli_bot'] } }),
    }));
    const r = await addBotToChat(ctx, 'oc_1', 'cli_bot', exec);
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(true);
  });

  it('reports failure when the bot ends up in the invalid list', async () => {
    const exec = stub(() => ({
      code: 0,
      stdout: JSON.stringify({ data: { invalid_id_list: ['cli_bot'] } }),
    }));
    const r = await addBotToChat(ctx, 'oc_1', 'cli_bot', exec);
    expect(r.ok).toBe(false);
  });
});
