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

type CallbackEnvelopeResult =
  | { ok: true; payload: CallbackPayload }
  | { ok: false; reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'expired' };

const PREFIX = 'bridge_cb.v1';

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

  /**
   * Read identity/scope from a server-signed callback before routing it. This
   * does not consume the nonce; callers must still invoke verify() before any
   * action. Invalid, expired, or revoked tokens are never exposed.
   */
  inspect(token: string): CallbackPayload | undefined {
    const verified = this.verifyEnvelope(token);
    if (!verified.ok) return undefined;
    const nonceState = this.nonceStore.state(verified.payload.n);
    return nonceState === 'revoked' || nonceState === 'used' ? undefined : verified.payload;
  }

  verify(token: string, expected: CallbackVerifyExpected): CallbackVerifyResult {
    const envelope = this.verifyEnvelope(token);
    if (!envelope.ok) return envelope;
    const { payload } = envelope;
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

  private verifyEnvelope(token: string): CallbackEnvelopeResult {
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

function encodeJson(payload: CallbackPayload): string {
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
