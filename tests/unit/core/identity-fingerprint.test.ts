import { describe, expect, it } from 'vitest';
import { authorizedIdentityFingerprint } from '../../../src/core/identity-fingerprint.js';

describe('authorized identity fingerprint', () => {
  it('produces stable domain-separated SHA-256 values', () => {
    expect(authorizedIdentityFingerprint('chat', 'oc_group')).toBe(
      'sha256:c0d49291450e14813b509a81e8fb672ce0794a2c7991e345170b05af4cba4ee7',
    );
    expect(authorizedIdentityFingerprint('operator', 'ou_operator')).toBe(
      'sha256:1fd2465f8c78bd60e46eff793ca548fdfc49cbda13c849f1212cfafaa256fdfc',
    );
    expect(authorizedIdentityFingerprint('message', 'om_card')).toBe(
      'sha256:92622a77472b21a43a4358ff0a12cb80e00631044d3d73d58f3c5b75c11c9bdf',
    );
  });

  it('rejects missing identities', () => {
    expect(() => authorizedIdentityFingerprint('chat', '')).toThrow('missing chat identity');
  });
});
