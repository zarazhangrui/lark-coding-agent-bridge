import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProfileRepin } from '../../../src/cli/commands/profile';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile repin command', () => {
  it('refreshes pin fields from the current codex binary when version has drifted', async () => {
    const root = await makeRoot();
    const binary = await writeVersionExecutable(root, 'codex', 'codex-cli 0.136.0');
    await writeCodexProfile(root, 'codex', {
      binaryPath: binary,
      realpath: binary,
      version: 'codex-cli 0.133.0',
      sha256: 'aa3c64b122c9d06bf48eaf988f5970aa69556d69506c3118cf07d10b2401b48a',
      owner: 501,
      mode: 0o755,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await runProfileRepin('codex', { rootDir: root });
    } finally {
      console.log = originalLog;
    }

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    const newPin = saved.profiles.codex?.codex;
    expect(newPin?.version).toBe('codex-cli 0.136.0');
    expect(newPin?.sha256).not.toBe(
      'aa3c64b122c9d06bf48eaf988f5970aa69556d69506c3118cf07d10b2401b48a',
    );
    expect(newPin?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(newPin?.binaryPath).toBe(binary);

    const combined = logs.join('\n');
    expect(combined).toContain('version');
    expect(combined).toContain('codex-cli 0.133.0');
    expect(combined).toContain('codex-cli 0.136.0');
  });

  it('prints (no changes) and leaves config untouched when the pin already matches disk', async () => {
    const root = await makeRoot();
    const binary = await writeVersionExecutable(root, 'codex', 'codex-cli 0.136.0');
    const resolved = await realpath(binary);
    const actualSha = await sha256OfFile(binary);
    const { stat } = await import('node:fs/promises');
    const info = await stat(binary);
    await writeCodexProfile(root, 'codex', {
      binaryPath: binary,
      realpath: resolved,
      version: 'codex-cli 0.136.0',
      sha256: actualSha,
      owner: info.uid,
      mode: info.mode & 0o7777,
    });

    const before = await readFile(join(root, 'config.json'), 'utf8');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await runProfileRepin('codex', { rootDir: root });
    } finally {
      console.log = originalLog;
    }
    const after = await readFile(join(root, 'config.json'), 'utf8');
    expect(after).toBe(before);
    expect(logs.join('\n')).toContain('(no changes)');
  });

  it('refuses to repin a non-codex profile with a clear error', async () => {
    const root = await makeRoot();
    await writeClaudeProfile(root, 'claude');

    await expect(runProfileRepin('claude', { rootDir: root })).rejects.toThrow(
      /not a codex profile/,
    );
  });

  it('throws profile not found when the profile name is unknown', async () => {
    const root = await makeRoot();
    await writeClaudeProfile(root, 'claude');

    await expect(runProfileRepin('nope', { rootDir: root })).rejects.toThrow(
      /profile not found: nope/,
    );
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-repin-'));
  roots.push(root);
  return root;
}

async function writeCodexProfile(
  root: string,
  name: string,
  codexPin: {
    binaryPath: string;
    realpath: string;
    version: string;
    sha256: string;
    owner?: number;
    mode?: number;
  },
): Promise<void> {
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: `cli_${name}`,
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    codex: codexPin,
  });
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile: name,
    preferences: {},
    profiles: { [name]: profile },
  };
  await writeJson(join(root, 'config.json'), config);
  await mkdir(join(root, 'profiles', name), { recursive: true });
}

async function writeClaudeProfile(root: string, name: string): Promise<void> {
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: `cli_${name}`,
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile: name,
    preferences: {},
    profiles: { [name]: profile },
  };
  await writeJson(join(root, 'config.json'), config);
  await mkdir(join(root, 'profiles', name), { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256OfFile(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { readFile: read } = await import('node:fs/promises');
  return createHash('sha256').update(await read(path)).digest('hex');
}
