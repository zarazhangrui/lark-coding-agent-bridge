import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const collectTsFiles = (path: string): string[] => {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return [];

  if (statSync(fullPath).isFile()) {
    return path.endsWith('.ts') ? [path] : [];
  }

  return readdirSync(fullPath)
    .flatMap((entry) => collectTsFiles(join(path, entry)))
    .sort();
};

describe('static architecture contracts', () => {
  it('does not route production runs by importing Codex internals in shared bot/card code', () => {
    const sharedFiles = [
      ...collectTsFiles('src/bot'),
      ...collectTsFiles('src/card'),
      'src/commands/index.ts',
    ];
    for (const file of sharedFiles) {
      expect(read(file), file).not.toMatch(/agent\/codex/);
    }
  });

  it('does not keep legacy open access semantics in config helpers', () => {
    const schema = read('src/config/schema.ts');
    expect(schema).not.toMatch(/legacy-open|access\.semantics/);

    const legacyOpenAccessPatterns = [
      /Empty\/undefined = allow everyone/,
      /Empty\/undefined =\s*\n\s*\* respond in all chats it's invited to\./,
      /Empty \/\s*\n\s*\* undefined = no admin restriction/,
      /Empty list = allow all/,
      /if \(!list \|\| list\.length === 0\) return true;/,
    ];
    for (const pattern of legacyOpenAccessPatterns) {
      expect(schema).not.toMatch(pattern);
    }
  });

  it('persists profile runtime state through atomic 0600 writes', () => {
    for (const file of ['src/session/store.ts', 'src/workspace/store.ts', 'src/card/callback-store.ts']) {
      const source = read(file);
      expect(source, file).toContain('writeFileAtomic');
      expect(source, file).toContain('mode: 0o600');
      expect(source, file).not.toMatch(/\bwriteFile\(/);
    }
  });

  it('AgentEvent includes a permission_request variant', () => {
    const evt: AgentEvent = {
      type: 'permission_request',
      id: 'perm-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      title: 'Claude wants to run ls',
    };
    expect(evt.type).toBe('permission_request');
  });

  it('AgentRun exposes optional respondPermission and steer', () => {
    const run: Pick<AgentRun, 'respondPermission' | 'steer'> = {
      respondPermission: (_id, _decision) => {},
      steer: (_text) => {},
    };
    run.respondPermission?.('perm-1', 'deny', { message: 'no' });
    run.steer?.('go left');
    expect(true).toBe(true);
  });
});
