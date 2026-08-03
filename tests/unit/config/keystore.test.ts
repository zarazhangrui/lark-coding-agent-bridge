import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = { value: 'machine-a.local' };

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: () => host.value };
});

const { resolveAppPaths } = await import('../../../src/config/app-paths');
const { clearKeystoreDerivedKeyCache, getSecret, listSecretIds, setSecret } = await import(
  '../../../src/config/keystore'
);

const LEGACY_HOSTNAME_ENV = 'LARK_CHANNEL_KEYSTORE_LEGACY_HOSTNAME';
const roots: string[] = [];

type TestPaths = ReturnType<typeof resolveAppPaths>;

async function tempPaths(): Promise<TestPaths> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-'));
  roots.push(root);
  const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
  await mkdir(dirname(paths.secretsFile), { recursive: true });
  return paths;
}

/** Write an entry in the pre-fix format: key derived from `hostname|username`. */
async function writeLegacyEntry(
  paths: TestPaths,
  id: string,
  plaintext: string,
  atHostname: string,
): Promise<void> {
  const salt = randomBytes(32);
  await writeFile(paths.keystoreSaltFile, salt, { mode: 0o600 });
  const key = pbkdf2Sync(`${atHostname}|${userInfo().username}`, salt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const store = {
    version: 1,
    entries: {
      [id]: {
        iv: iv.toString('base64'),
        data: data.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
    },
  };
  await writeFile(paths.secretsFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function readEntry(secretsFile: string, id: string): Promise<{ kdf?: string } | undefined> {
  const parsed = JSON.parse(await readFile(secretsFile, 'utf8')) as {
    entries: Record<string, { kdf?: string }>;
  };
  return parsed.entries[id];
}

beforeEach(() => {
  host.value = 'machine-a.local';
  delete process.env[LEGACY_HOSTNAME_ENV];
  clearKeystoreDerivedKeyCache();
});

afterEach(async () => {
  delete process.env[LEGACY_HOSTNAME_ENV];
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('keystore', () => {
  it('round-trips a secret and lists its id', async () => {
    const paths = await tempPaths();

    await setSecret('app-cli_x', 'super-secret', paths);

    expect(await getSecret('app-cli_x', paths)).toBe('super-secret');
    expect(await listSecretIds(paths)).toEqual(['app-cli_x']);
  });

  it('returns undefined for an unknown id', async () => {
    const paths = await tempPaths();

    expect(await getSecret('app-missing', paths)).toBeUndefined();
  });

  it('keeps entries readable after the machine hostname changes', async () => {
    const paths = await tempPaths();
    await setSecret('app-cli_x', 'super-secret', paths);

    // mDNS bumps the .local name on a collision, IT renames the host, …
    host.value = 'machine-b.local';
    clearKeystoreDerivedKeyCache();

    expect(await getSecret('app-cli_x', paths)).toBe('super-secret');
  });

  it('reads a legacy hostname-encrypted entry and migrates it off the hostname', async () => {
    const paths = await tempPaths();
    await writeLegacyEntry(paths, 'app-cli_x', 'legacy-secret', 'machine-a.local');
    expect(await readEntry(paths.secretsFile, 'app-cli_x')).not.toHaveProperty('kdf', 'keyfile');

    expect(await getSecret('app-cli_x', paths)).toBe('legacy-secret');

    // Migrated in place, so a later rename cannot strand it.
    expect(await readEntry(paths.secretsFile, 'app-cli_x')).toHaveProperty('kdf', 'keyfile');
    host.value = 'machine-b.local';
    clearKeystoreDerivedKeyCache();
    expect(await getSecret('app-cli_x', paths)).toBe('legacy-secret');
  });

  it('fails with an actionable error when a legacy entry outlives its hostname', async () => {
    const paths = await tempPaths();
    await writeLegacyEntry(paths, 'app-cli_x', 'legacy-secret', 'machine-a.local');

    host.value = 'machine-b.local';
    clearKeystoreDerivedKeyCache();

    const err = await getSecret('app-cli_x', paths).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('app-cli_x');
    expect(message).toContain('hostname');
    expect(message).toContain('machine-b.local');
    expect(message).toContain(LEGACY_HOSTNAME_ENV);
    expect(message).toContain('secrets set');
    // The bare node error text is what made this undiagnosable before.
    expect(message).not.toBe('Unsupported state or unable to authenticate data');
  });

  it('recovers a stranded legacy entry when the previous hostname is supplied', async () => {
    const paths = await tempPaths();
    await writeLegacyEntry(paths, 'app-cli_x', 'legacy-secret', 'machine-a.local');

    host.value = 'machine-b.local';
    process.env[LEGACY_HOSTNAME_ENV] = 'machine-a.local';
    clearKeystoreDerivedKeyCache();

    expect(await getSecret('app-cli_x', paths)).toBe('legacy-secret');

    // Recovery is one-shot: the entry is re-keyed, so the env var is no
    // longer needed on the next start.
    delete process.env[LEGACY_HOSTNAME_ENV];
    clearKeystoreDerivedKeyCache();
    expect(await getSecret('app-cli_x', paths)).toBe('legacy-secret');
  });

  it('still returns the secret when the migration write cannot be persisted', async () => {
    const paths = await tempPaths();
    await writeLegacyEntry(paths, 'app-cli_x', 'legacy-secret', 'machine-a.local');
    const profileDir = dirname(paths.secretsFile);
    await chmod(profileDir, 0o500);

    try {
      expect(await getSecret('app-cli_x', paths)).toBe('legacy-secret');
    } finally {
      await chmod(profileDir, 0o700);
    }
  });
});
