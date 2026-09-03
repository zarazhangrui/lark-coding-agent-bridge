import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('CallbackAuth', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it('signs and verifies all callback context fields', async () => {
    const h = await harness();
    const token = h.auth.sign({
      runId: 'run-1',
      scope: 'chat-1',
      chatId: 'oc_1',
      operatorOpenId: 'ou_1',
      action: 'stop',
      policyFingerprint: 'fp-1',
      ttlMs: 60_000,
    });

    expect(token).toMatch(/^bridge_cb\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(
      h.auth.verify(token, {
        runId: 'run-1',
        scope: 'chat-1',
        chatId: 'oc_1',
        operatorOpenId: 'ou_1',
        action: 'stop',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['runId', { runId: 'run-other' }],
    ['scope', { scope: 'chat-other' }],
    ['chatId', { chatId: 'oc_other' }],
    ['operator', { operatorOpenId: 'ou_other' }],
    ['action', { action: 'resume' }],
    ['policy fingerprint', { policyFingerprint: 'fp-other' }],
  ])('rejects mismatched %s', async (_label, override) => {
    const h = await harness();
    const token = h.auth.sign(baseSignInput());

    expect(
      h.auth.verify(token, {
        ...baseExpected(),
        ...override,
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects expired tokens', async () => {
    const h = await harness({ now: 1000 });
    const token = h.auth.sign({ ...baseSignInput(), ttlMs: 10 });
    h.setNow(1011);

    expect(h.auth.verify(token, baseExpected())).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects nonce replay after verification and after nonce store reload', async () => {
    const h = await harness();
    const token = h.auth.sign(baseSignInput());

    expect(h.auth.verify(token, baseExpected())).toMatchObject({ ok: true });
    expect(h.auth.verify(token, baseExpected())).toMatchObject({
      ok: false,
      reason: 'nonce-replay',
    });
    await h.store.flush();

    const reloadedStore = new CallbackNonceStore(h.storePath);
    await reloadedStore.load();
    const reloaded = new CallbackAuth({
      keys: [{ version: 1, secret: 'secret-1' }],
      nonceStore: reloadedStore,
      now: () => h.now(),
      createNonce: () => 'unused',
    });
    expect(reloaded.verify(token, baseExpected())).toMatchObject({
      ok: false,
      reason: 'nonce-replay',
    });
  });

  it('verifies retired keys but signs with the newest active key', async () => {
    const h = await harness({
      keys: [
        { version: 1, secret: 'old-secret', retired: true },
        { version: 2, secret: 'new-secret' },
      ],
    });

    const token = h.auth.sign(baseSignInput());
    expect(JSON.parse(Buffer.from(token.split('.')[2]!, 'base64url').toString('utf8'))).toMatchObject({
      kv: 2,
    });
    expect(h.auth.verify(token, baseExpected())).toMatchObject({ ok: true });

    const old = new CallbackAuth({
      keys: [{ version: 1, secret: 'old-secret' }],
      nonceStore: new CallbackNonceStore(await path()),
      now: () => h.now(),
      createNonce: () => 'old-nonce',
    }).sign(baseSignInput());
    expect(h.auth.verify(old, baseExpected())).toMatchObject({ ok: true });
  });

  it('rejects force-revoked nonces', async () => {
    const h = await harness({ nonce: 'nonce-revoke' });
    const token = h.auth.sign(baseSignInput());
    h.store.revoke('nonce-revoke');

    expect(h.auth.verify(token, baseExpected())).toMatchObject({
      ok: false,
      reason: 'nonce-revoked',
    });
  });

  it('signs reusable persistent controls without consuming a nonce', async () => {
    const h = await harness();
    const token = h.auth.signPersistentControl({
      profile: 'codex',
      scope: 'oc_1:th_1',
      chatId: 'oc_1',
      action: 'controls.stop',
      ttlMs: 60_000,
    });
    const expected = {
      profile: 'codex',
      scope: 'oc_1:th_1',
      chatId: 'oc_1',
      action: 'controls.stop',
    };

    expect(token).toMatch(/^bridge_control\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(h.auth.verifyPersistentControl(token, expected)).toMatchObject({ ok: true });
    expect(h.auth.verifyPersistentControl(token, expected)).toMatchObject({ ok: true });
  });

  it.each([
    ['profile', { profile: 'other' }],
    ['scope', { scope: 'oc_other' }],
    ['chat', { chatId: 'oc_other' }],
    ['action', { action: 'controls.other' }],
  ])('rejects persistent controls with mismatched %s', async (_label, override) => {
    const h = await harness();
    const token = h.auth.signPersistentControl({
      profile: 'codex',
      scope: 'oc_1',
      chatId: 'oc_1',
      action: 'controls.stop',
      ttlMs: 60_000,
    });

    expect(
      h.auth.verifyPersistentControl(token, {
        profile: 'codex',
        scope: 'oc_1',
        chatId: 'oc_1',
        action: 'controls.stop',
        ...override,
      }),
    ).toMatchObject({ ok: false, reason: 'context-mismatch' });
  });

  it('rejects expired persistent controls', async () => {
    const h = await harness({ now: 1000 });
    const token = h.auth.signPersistentControl({
      profile: 'codex',
      scope: 'oc_1',
      chatId: 'oc_1',
      action: 'controls.stop',
      ttlMs: 10,
    });
    h.setNow(1011);

    expect(
      h.auth.verifyPersistentControl(token, {
        profile: 'codex',
        scope: 'oc_1',
        chatId: 'oc_1',
        action: 'controls.stop',
      }),
    ).toMatchObject({ ok: false, reason: 'expired' });
  });
});

function baseSignInput() {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'oc_1',
    operatorOpenId: 'ou_1',
    action: 'stop',
    policyFingerprint: 'fp-1',
    ttlMs: 60_000,
  };
}

function baseExpected() {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'oc_1',
    operatorOpenId: 'ou_1',
    action: 'stop',
    policyFingerprint: 'fp-1',
  };
}

async function harness(options: {
  now?: number;
  nonce?: string;
  keys?: Array<{ version: number; secret: string; retired?: boolean }>;
} = {}) {
  let now = options.now ?? 1000;
  const storePath = await path();
  const store = new CallbackNonceStore(storePath);
  cleanups.push(() => store.flush());
  const auth = new CallbackAuth({
    keys: options.keys ?? [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => now,
    createNonce: () => options.nonce ?? 'nonce-1',
  });
  return {
    auth,
    store,
    storePath,
    now: () => now,
    setNow: (next: number) => {
      now = next;
    },
  };
}

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'callback-auth-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'nonces.json');
}
