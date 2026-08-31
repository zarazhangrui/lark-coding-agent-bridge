import { createHash } from 'node:crypto';

export type IdentityFingerprintKind = 'chat' | 'operator' | 'message';

const DOMAIN = 'lark-channel-bridge:authorized-identity:v1';

/**
 * Stable, one-way identity for access-checked telemetry consumers.
 *
 * The kind is part of the preimage so the same raw value cannot be correlated
 * across identity classes. Raw provider identifiers remain inside the bridge.
 */
export function authorizedIdentityFingerprint(
  kind: IdentityFingerprintKind,
  value: string,
): string {
  if (!value) throw new Error(`missing ${kind} identity`);
  return `sha256:${createHash('sha256').update(`${DOMAIN}\0${kind}\0${value}`, 'utf8').digest('hex')}`;
}
