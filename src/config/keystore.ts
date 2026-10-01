import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import type { AppPaths } from './app-paths';
import { paths } from './paths';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Local AES-256-GCM keystore for App Secrets and similar.
 *
 * Layout on disk:
 *   ~/.lark-channel/secrets.enc      — JSON map { id → encrypted envelope }
 *   ~/.lark-channel/.keystore.salt   — 32 random bytes, generated once
 *   ~/.lark-channel/.keystore.key    — 32 random bytes, generated once
 *
 * All three are chmod 0600. The encryption key is derived (PBKDF2-SHA256,
 * 100k iters) from the key file + salt. This is **defense-in-depth against
 * accidental disclosure** (backups, git commits, log dumps) — *not* against
 * a same-user process actively decrypting. That threat needs a real OS
 * keychain, which is out of scope for this bridge given lark-cli already
 * terminates secrets in its own keychain on bind.
 *
 * Envelopes written before the key file existed were keyed off
 * `hostname + username + salt` instead. A hostname is not stable identity —
 * mDNS renames a colliding `.local` name (`host-2` → `host-3`), and managed
 * fleets rename hosts outright — and every such rename silently stranded the
 * keystore behind an unreadable `Unsupported state or unable to authenticate
 * data`. Those envelopes are still read (see `KDF_HOSTNAME`) and are
 * re-keyed onto the key file the first time they are opened.
 */

const KEY_LEN = 32;
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM auth tag
const PBKDF2_ITER = 100_000;
const FILE_VERSION = 1;
/** Legacy KDF: key from `hostname|username`. Implied when `kdf` is absent. */
const KDF_HOSTNAME = 'hostname';
/** Current KDF: key from the machine-local random key file. */
const KDF_KEYFILE = 'keyfile';
/** Escape hatch to re-open entries stranded by a rename, see module doc. */
const LEGACY_HOSTNAME_ENV = 'LARK_CHANNEL_KEYSTORE_LEGACY_HOSTNAME';
const derivedKeyCache = new Map<string, Buffer>();

interface Envelope {
  /** base64 of 12-byte IV */
  iv: string;
  /** base64 of ciphertext */
  data: string;
  /** base64 of 16-byte GCM auth tag */
  tag: string;
  /** Which key derivation produced this envelope. Absent → `hostname`. */
  kdf?: typeof KDF_HOSTNAME | typeof KDF_KEYFILE;
}

interface StoreFile {
  version: number;
  entries: Record<string, Envelope>;
}

export type KeystorePaths = Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'keystoreKeyFile'>;

/** Read + return the full keystore. Missing file or unreadable → empty store. */
async function readStore(storePaths: KeystorePaths = paths): Promise<StoreFile> {
  try {
    const text = await readFile(storePaths.secretsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return emptyStore();
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

function emptyStore(): StoreFile {
  return { version: FILE_VERSION, entries: {} };
}

async function writeStore(store: StoreFile, storePaths: KeystorePaths = paths): Promise<void> {
  await writeFileAtomic(storePaths.secretsFile, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Load the salt, or generate one if absent. The salt is **not a secret** —
 * an attacker that can read this file can also read the keystore. Its job
 * is to ensure two users on the same machine don't derive the same key.
 */
async function loadOrCreateSalt(storePaths: KeystorePaths = paths): Promise<Buffer> {
  try {
    const buf = await readFile(storePaths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const salt = randomBytes(KEY_LEN);
  await writeFileAtomic(storePaths.keystoreSaltFile, salt, { mode: 0o600 });
  return salt;
}

/**
 * Load the machine-local key material, or generate it if absent. Unlike the
 * salt this *is* the secret, so a wrong-sized file is treated as corruption
 * rather than silently replaced — overwriting it would strand every entry.
 */
async function loadOrCreateKeyMaterial(storePaths: KeystorePaths = paths): Promise<Buffer> {
  let existing: Buffer | undefined;
  try {
    existing = await readFile(storePaths.keystoreKeyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (existing.length === KEY_LEN) return existing;
    throw new Error(
      `keystore key file ${storePaths.keystoreKeyFile} is ${existing.length} bytes, ` +
        `expected ${KEY_LEN}; refusing to overwrite it — move it aside and re-add ` +
        'your secrets to start over',
    );
  }
  const material = randomBytes(KEY_LEN);
  await writeFileAtomic(storePaths.keystoreKeyFile, material, { mode: 0o600 });
  return material;
}

async function deriveKey(storePaths: KeystorePaths = paths): Promise<Buffer> {
  const cacheKey = `${storePaths.keystoreSaltFile}|${KDF_KEYFILE}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = await loadOrCreateSalt(storePaths);
  const material = await loadOrCreateKeyMaterial(storePaths);
  const key = pbkdf2Sync(material, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
  derivedKeyCache.set(cacheKey, key);
  return key;
}

async function deriveLegacyKey(host: string, storePaths: KeystorePaths = paths): Promise<Buffer> {
  const cacheKey = `${storePaths.keystoreSaltFile}|${KDF_HOSTNAME}|${host}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = await loadOrCreateSalt(storePaths);
  const seed = `${host}|${userInfo().username}`;
  const key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
  derivedKeyCache.set(cacheKey, key);
  return key;
}

function encrypt(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    data: enc.toString('base64'),
    tag: tag.toString('base64'),
    kdf: KDF_KEYFILE,
  };
}

function decrypt(key: Buffer, env: Envelope): string {
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.data, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

/** Look up an entry by id (e.g. "app-cli_xxx"). Returns plaintext or
 * `undefined` when not present. Errors (decryption failure, invalid file)
 * propagate. */
export async function getSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<string | undefined> {
  const store = await readStore(storePaths);
  const env = store.entries[id];
  if (!env) return undefined;
  if (env.kdf === KDF_KEYFILE) {
    return decrypt(await deriveKey(storePaths), env);
  }
  const plaintext = await decryptLegacy(id, env, storePaths);
  await migrateEntry(id, plaintext, store, storePaths);
  return plaintext;
}

/**
 * Open a pre-key-file envelope. Tries this machine's current hostname, then
 * whatever the operator pinned in `LARK_CHANNEL_KEYSTORE_LEGACY_HOSTNAME`.
 */
async function decryptLegacy(
  id: string,
  env: Envelope,
  storePaths: KeystorePaths,
): Promise<string> {
  const current = hostname();
  const override = process.env[LEGACY_HOSTNAME_ENV]?.trim();
  const candidates = override && override !== current ? [current, override] : [current];
  for (const host of candidates) {
    try {
      return decrypt(await deriveLegacyKey(host, storePaths), env);
    } catch {
      // Wrong hostname → GCM tag mismatch. Fall through to the next guess.
    }
  }
  throw new Error(
    `failed to decrypt keystore entry "${id}": it was encrypted with a key derived from this ` +
      `machine's hostname, which has changed since (now "${current}"). Re-add the secret with ` +
      '`lark-channel-bridge secrets set`, or — if you know the hostname it was stored under — ' +
      `start once with ${LEGACY_HOSTNAME_ENV}="<previous hostname>" to re-key it automatically.`,
  );
}

/**
 * Re-encrypt a legacy entry onto the key file so the next rename cannot
 * strand it. Best effort: a read-only or otherwise unwritable profile must
 * not turn a successful read into a failure.
 */
async function migrateEntry(
  id: string,
  plaintext: string,
  store: StoreFile,
  storePaths: KeystorePaths,
): Promise<void> {
  try {
    const key = await deriveKey(storePaths);
    store.entries[id] = encrypt(key, plaintext);
    await writeStore(store, storePaths);
  } catch {
    // Keep serving the secret; we retry the migration on the next read.
  }
}

/** Store / overwrite the secret for `id`. */
export async function setSecret(
  id: string,
  plaintext: string,
  storePaths: KeystorePaths = paths,
): Promise<void> {
  const key = await deriveKey(storePaths);
  const env = encrypt(key, plaintext);
  const store = await readStore(storePaths);
  store.entries[id] = env;
  await writeStore(store, storePaths);
}

/** Remove an entry. Returns true if something was removed. */
export async function removeSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<boolean> {
  const store = await readStore(storePaths);
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  await writeStore(store, storePaths);
  return true;
}

/** List ids (no secrets in the output, by design). */
export async function listSecretIds(storePaths: KeystorePaths = paths): Promise<string[]> {
  const store = await readStore(storePaths);
  return Object.keys(store.entries);
}

export function clearKeystoreDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

export function keystoreDerivedKeyCacheSize(): number {
  return derivedKeyCache.size;
}
