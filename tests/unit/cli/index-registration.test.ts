import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('registers the documented migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('runMigrate');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers Codex transport for every profile bootstrap entry point', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const transportOptions = source.match(/--codex-transport <transport>/g) ?? [];
    expect(transportOptions).toHaveLength(4);
    expect(source).toContain('exec or app-server; default exec');
  });

  it('registers the controller workspace Codex task command group', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]codex-task['"]\)/);
    for (const subcommand of ['init', 'list', 'create', 'read <handle>', 'send <handle>']) {
      expect(source).toContain(`.command('${subcommand}')`);
    }
  });
});
