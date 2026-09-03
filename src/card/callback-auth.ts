import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallbackNonceStore } from './callback-store';

export interface CallbackKey {
  version: number;
  secret: string;
  retired?: boolean;
}

export interface CallbackAuthOptions {
  keys: CallbackKey[];
  nonceStore: CallbackNonceStore;
  now?: () => number;
  createNonce?: () => string;
}

export interface CallbackSignInput {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
  ttlMs: number;
}

export interface CallbackVerifyExpected {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
}

export interface CallbackPayload {
  r: string;
  s: string;
  c: string;
  o: string;
  a: string;
  exp: number;
  fp: string;
  n: string;
  kv: number;
}

export interface PersistentControlSignInput {
  profile: string;
  scope: string;
  chatId: string;
  action: string;
  ttlMs: number;
}

export interface PersistentControlVerifyExpected {
  profile: string;
  scope: string;
  chatId: string;
  action: string;
}

export interface PersistentControlPayload {
  p: string;
  s: string;
  c: string;
  a: string;
  exp: number;
  kv: number;
}

export type PersistentControlVerifyResult =
  | { ok: true; payload: PersistentControlPayload }
  | Exclude<CallbackVerifyResult, { ok: true }>;

export type CallbackVerifyResult =
  | { ok: true; payload: CallbackPayload }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'unknown-key'
        | 'bad-signature'
        | 'expired'
        | 'context-mismatch'
        | 'nonce-replay'
        | 'nonce-revoked';
    };

const PREFIX = 'bridge_cb.v1';
const CONTROL_PREFIX = 'bridge_control.v1';

export class CallbackAuth {
  private readonly keys: CallbackKey[];
  private readonly nonceStore: CallbackNonceStore;
  private readonly now: () => number;
  private readonly createNonce: () => string;

  constructor(options: CallbackAuthOptions) {
    this.keys = [...options.keys].sort((a, b) => a.version - b.version);
    if (this.keys.length === 0) throw new Error('at least one callback key is required');
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString('base64url'));
  }

  sign(input: CallbackSignInput): string {
    const key = this.signingKey();
    const payload: CallbackPayload = {
      r: input.runId,
      s: input.scope,
      c: input.chatId,
      o: input.operatorOpenId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      fp: input.policyFingerprint,
      n: this.createNonce(),
      kv: key.version,
    };
    const encoded = encodeJson(payload);
    return `${PREFIX}.${encoded}.${sign(encoded, key.secret)}`;
  }

  verify(token: string, expected: CallbackVerifyExpected): CallbackVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encodedPayload = parts[2];
    const signature = parts[3];
    if (!encodedPayload || !signature) return { ok: false, reason: 'malformed' };

    const payload = decodePayload(encodedPayload);
    if (!payload) return { ok: false, reason: 'malformed' };
    const key = this.keys.find((candidate) => candidate.version === payload.kv);
    if (!key) return { ok: false, reason: 'unknown-key' };
    if (!signatureMatches(signature, sign(encodedPayload, key.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: 'expired' };
    if (!matchesExpected(payload, expected)) {
      return { ok: false, reason: 'context-mismatch' };
    }

    const nonceState = this.nonceStore.state(payload.n);
    if (nonceState === 'revoked') return { ok: false, reason: 'nonce-revoked' };
    if (nonceState === 'used') return { ok: false, reason: 'nonce-replay' };
    if (!this.nonceStore.consume(payload.n)) {
      return { ok: false, reason: 'nonce-replay' };
    }
    return { ok: true, payload };
  }

  /**
   * Sign a reusable, run-independent control. Unlike an agent callback this
   * intentionally has no run id, operator id, or one-shot nonce: authorization
   * is re-evaluated when the card is clicked, while the signature binds the
   * action to one profile and one chat/topic scope.
   */
  signPersistentControl(input: PersistentControlSignInput): string {
    const key = this.signingKey();
    const payload: PersistentControlPayload = {
      p: input.profile,
      s: input.scope,
      c: input.chatId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      kv: key.version,
    };
    const encoded = encodeJson(payload);
    return `${CONTROL_PREFIX}.${encoded}.${sign(encoded, key.secret)}`;
  }

  verifyPersistentControl(
    token: string,
    expected: PersistentControlVerifyExpected,
  ): PersistentControlVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== CONTROL_PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encodedPayload = parts[2];
    const signature = parts[3];
    if (!encodedPayload || !signature) return { ok: false, reason: 'malformed' };

    const payload = decodePersistentControlPayload(encodedPayload);
    if (!payload) return { ok: false, reason: 'malformed' };
    const key = this.keys.find((candidate) => candidate.version === payload.kv);
    if (!key) return { ok: false, reason: 'unknown-key' };
    if (!signatureMatches(signature, sign(encodedPayload, key.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: 'expired' };
    if (
      payload.p !== expected.profile ||
      payload.s !== expected.scope ||
      payload.c !== expected.chatId ||
      payload.a !== expected.action
    ) {
      return { ok: false, reason: 'context-mismatch' };
    }
    return { ok: true, payload };
  }

  private signingKey(): CallbackKey {
    const active = this.keys.filter((key) => !key.retired);
    const key = active.at(-1);
    if (!key) throw new Error('no active callback signing key');
    return key;
  }
}

function matchesExpected(
  payload: CallbackPayload,
  expected: CallbackVerifyExpected,
): boolean {
  return (
    payload.r === expected.runId &&
    payload.s === expected.scope &&
    payload.c === expected.chatId &&
    payload.o === expected.operatorOpenId &&
    payload.a === expected.action &&
    payload.fp === expected.policyFingerprint
  );
}

function encodeJson(payload: CallbackPayload | PersistentControlPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(encoded: string): CallbackPayload | undefined {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CallbackPayload>;
    if (
      typeof raw.r !== 'string' ||
      typeof raw.s !== 'string' ||
      typeof raw.c !== 'string' ||
      typeof raw.o !== 'string' ||
      typeof raw.a !== 'string' ||
      typeof raw.exp !== 'number' ||
      typeof raw.fp !== 'string' ||
      typeof raw.n !== 'string' ||
      typeof raw.kv !== 'number'
    ) {
      return undefined;
    }
    return {
      r: raw.r,
      s: raw.s,
      c: raw.c,
      o: raw.o,
      a: raw.a,
      exp: raw.exp,
      fp: raw.fp,
      n: raw.n,
      kv: raw.kv,
    };
  } catch {
    return undefined;
  }
}

function decodePersistentControlPayload(encoded: string): PersistentControlPayload | undefined {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<PersistentControlPayload>;
    if (
      typeof raw.p !== 'string' ||
      typeof raw.s !== 'string' ||
      typeof raw.c !== 'string' ||
      typeof raw.a !== 'string' ||
      typeof raw.exp !== 'number' ||
      typeof raw.kv !== 'number'
    ) {
      return undefined;
    }
    return { p: raw.p, s: raw.s, c: raw.c, a: raw.a, exp: raw.exp, kv: raw.kv };
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
