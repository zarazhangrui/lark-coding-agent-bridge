import { describe, expect, it, vi } from 'vitest';
import { runCommandHandler, type CommandContext } from '../../../src/commands/index.js';

function makeCtx(overrides: { fromCardAction: boolean; respond?: ReturnType<typeof vi.fn> }) {
  const respond = overrides.respond ?? vi.fn();
  const ctx = {
    channel: { send: vi.fn() },
    msg: { chatId: 'c1', messageId: 'm1', senderId: 'u1', content: '' },
    scope: 'c1',
    chatMode: 'p2p',
    sessions: {},
    workspaces: {},
    agent: {},
    activeRuns: { get: () => ({ run: { respondPermission: respond }, interrupted: false }) },
    controls: { profileConfig: {}, cfg: {} },
    fromCardAction: overrides.fromCardAction,
  } as unknown as CommandContext;
  return { ctx, respond };
}

describe('/perm handler', () => {
  it('routes card-click allow to respondPermission', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: true });
    const ok = await runCommandHandler('perm', 'allow tu-1', ctx);
    expect(ok).toBe(true);
    expect(respond).toHaveBeenCalledWith('tu-1', 'allow');
  });

  it('routes deny', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: true });
    await runCommandHandler('perm', 'deny tu-2', ctx);
    expect(respond).toHaveBeenCalledWith('tu-2', 'deny');
  });

  it('rejects text-command invocation (no card action)', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: false });
    await runCommandHandler('perm', 'allow tu-1', ctx);
    expect(respond).not.toHaveBeenCalled();
  });

  it('is a silent no-op without an active run or with bad args', async () => {
    const respond = vi.fn();
    const { ctx } = makeCtx({ fromCardAction: true, respond });
    (ctx as { activeRuns: unknown }).activeRuns = { get: () => undefined };
    await expect(runCommandHandler('perm', 'allow tu-1', ctx)).resolves.toBe(true);
    const { ctx: ctx2, respond: r2 } = makeCtx({ fromCardAction: true });
    await runCommandHandler('perm', 'frobnicate tu-1', ctx2);
    expect(r2).not.toHaveBeenCalled();
  });
});
