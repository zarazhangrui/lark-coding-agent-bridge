import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface CallbackRegistrationInput {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
  ttlMs: number;
}

export interface CallbackRegistration {
  id: string;
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
  expiresAt: number;
  state: 'active' | 'used' | 'revoked';
}

export type CallbackRegistryVerifyResult =
  | { ok: true; registration: CallbackRegistration }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'expired'
        | 'context-mismatch'
        | 'used'
        | 'revoked'
        | 'malformed';
    };

export interface CallbackRegistryExpected {
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
}

export class CallbackRegistryStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private registrations = new Map<string, CallbackRegistration>();
  private saving: Promise<void> = Promise.resolve();

  constructor(path: string, opts: { now?: () => number; createId?: () => string } = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.createId = opts.createId ?? (() => randomUUID());
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      this.registrations.clear();
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const registration = parseRegistration(id, value);
        if (registration) this.registrations.set(id, registration);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('callback-registry', err, { step: 'load' });
    }
  }

  async register(input: CallbackRegistrationInput): Promise<CallbackRegistration> {
    await this.load();
    const id = this.createId();
    const registration: CallbackRegistration = {
      id,
      runId: input.runId,
      scope: input.scope,
      chatId: input.chatId,
      operatorOpenId: input.operatorOpenId,
      action: input.action,
      policyFingerprint: input.policyFingerprint,
      expiresAt: this.now() + input.ttlMs,
      state: 'active',
    };
    this.registrations.set(id, registration);
    this.pruneExpired();
    await this.persist();
    return registration;
  }

  async consume(
    id: string,
    expected: CallbackRegistryExpected,
  ): Promise<CallbackRegistryVerifyResult> {
    if (!id || id.length > 200) return { ok: false, reason: 'malformed' };
    await this.load();
    const registration = this.registrations.get(id);
    if (!registration) return { ok: false, reason: 'missing' };
    if (registration.state === 'used') return { ok: false, reason: 'used' };
    if (registration.state === 'revoked') return { ok: false, reason: 'revoked' };
    if (registration.expiresAt <= this.now()) {
      registration.state = 'revoked';
      await this.persist();
      return { ok: false, reason: 'expired' };
    }
    if (!matchesExpected(registration, expected)) {
      return { ok: false, reason: 'context-mismatch' };
    }
    registration.state = 'used';
    await this.persist();
    return { ok: true, registration };
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private pruneExpired(): void {
    const cutoff = this.now();
    for (const [id, registration] of this.registrations.entries()) {
      if (registration.expiresAt <= cutoff && registration.state !== 'active') {
        this.registrations.delete(id);
      }
    }
  }

  private async persist(): Promise<void> {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(
          this.path,
          `${JSON.stringify(Object.fromEntries(this.registrations), null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('callback-registry', err, { step: 'persist' });
      });
    await this.saving;
  }
}

function matchesExpected(
  registration: CallbackRegistration,
  expected: CallbackRegistryExpected,
): boolean {
  return (
    registration.scope === expected.scope &&
    registration.chatId === expected.chatId &&
    registration.operatorOpenId === expected.operatorOpenId &&
    registration.action === expected.action
  );
}

function parseRegistration(id: string, value: unknown): CallbackRegistration | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<CallbackRegistration>;
  if (
    typeof raw.runId !== 'string' ||
    typeof raw.scope !== 'string' ||
    typeof raw.chatId !== 'string' ||
    typeof raw.operatorOpenId !== 'string' ||
    typeof raw.action !== 'string' ||
    typeof raw.policyFingerprint !== 'string' ||
    typeof raw.expiresAt !== 'number' ||
    (raw.state !== 'active' && raw.state !== 'used' && raw.state !== 'revoked')
  ) {
    return undefined;
  }
  return {
    id,
    runId: raw.runId,
    scope: raw.scope,
    chatId: raw.chatId,
    operatorOpenId: raw.operatorOpenId,
    action: raw.action,
    policyFingerprint: raw.policyFingerprint,
    expiresAt: raw.expiresAt,
    state: raw.state,
  };
}
