import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNewProfile } from '../../../src/ui/onboard';
import { loadRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-onboard-'));
  roots.push(root);
  return root;
}

describe('writeNewProfile (new-profile is additive)', () => {
  it('refuses to overwrite an existing profile and lets a new name coexist', async () => {
    const root = await tmpRoot();
    const base = {
      profile: 'claude',
      agentKind: 'claude' as const,
      appSecret: 'secret',
      tenant: 'feishu' as const,
      workspace: root,
    };

    const first = await writeNewProfile({ ...base, appId: 'cli_a' }, root);
    expect(first.profile).toBe('claude');

    // Same name → refuse (do NOT clobber the existing profile).
    await expect(writeNewProfile({ ...base, appId: 'cli_b' }, root)).rejects.toThrow(/已存在/);

    // The existing profile still points at the original app.
    const afterCollision = (await loadRootConfig(join(root, 'config.json')))!;
    expect(afterCollision.profiles.claude?.accounts.app.id).toBe('cli_a');

    // A different name is added alongside.
    const second = await writeNewProfile({ ...base, profile: 'work', appId: 'cli_b' }, root);
    expect(second.profile).toBe('work');
    const root2 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(Object.keys(root2.profiles).sort()).toEqual(['claude', 'work']);
  });

  it('creates a profile with a Unicode (Chinese) name from the scanned bot name', async () => {
    const root = await tmpRoot();

    const created = await writeNewProfile(
      {
        profile: '尼莫',
        agentKind: 'claude',
        appId: 'cli_nimo',
        appSecret: 'secret',
        tenant: 'feishu',
        workspace: root,
      },
      root,
    );
    expect(created.profile).toBe('尼莫');

    const cfg = (await loadRootConfig(join(root, 'config.json')))!;
    expect(cfg.profiles['尼莫']?.accounts.app.id).toBe('cli_nimo');
  });

  it('rejects a path-unsafe profile name with a clear 400 (not a 500)', async () => {
    const root = await tmpRoot();
    await expect(
      writeNewProfile(
        { profile: 'a/b', agentKind: 'claude', appId: 'cli_x', appSecret: 's', tenant: 'feishu' },
        root,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
