import { describe, expect, it } from 'vitest';
import { QoderAdapter, toQoderPermissionMode } from '../../../src/agent/qodercli/adapter';

describe('QoderAdapter', () => {
  it('identifies itself as qodercli', () => {
    const adapter = new QoderAdapter({ binary: 'qodercli' });
    expect(adapter.id).toBe('qodercli');
    expect(adapter.displayName).toBe('Qoder CLI');
  });

  it('requires cwd before running', () => {
    const adapter = new QoderAdapter({ binary: 'qodercli' });
    expect(() => adapter.run({ prompt: 'hi' } as never)).toThrow(/cwd is required/);
  });
});

describe('toQoderPermissionMode', () => {
  it('maps the bridge Claude-shaped modes onto qodercli snake_case values', () => {
    expect(toQoderPermissionMode('acceptEdits')).toBe('accept_edits');
    expect(toQoderPermissionMode('bypassPermissions')).toBe('bypass_permissions');
  });

  it('falls back to default for plan, default, and unset modes', () => {
    expect(toQoderPermissionMode('plan')).toBe('default');
    expect(toQoderPermissionMode('default')).toBe('default');
    expect(toQoderPermissionMode(undefined)).toBe('default');
  });
});
