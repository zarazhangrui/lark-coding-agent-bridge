import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
      expect(read(file), file).not.toMatch(/agent\/opencode/);
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
});
