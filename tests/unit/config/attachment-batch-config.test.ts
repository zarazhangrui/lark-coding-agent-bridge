import { describe, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';

const base = { schemaVersion: 2, agentKind: 'claude', accounts: { app: { id: 'cli_x', secret: 'x', tenant: 'feishu' } } };

describe('attachment batch settings', () => {
  it('default to 3 / 20 and are bounded', () => {
    expect(normalizeProfileConfig(base).attachments).toMatchObject({ batchThreshold: 3, batchKeep: 20 });
    const a = normalizeProfileConfig({ ...base, attachments: { batchThreshold: 0, batchKeep: 10_000 } }).attachments;
    expect([a.batchThreshold, a.batchKeep]).toEqual([1, 500]);
  });
});
