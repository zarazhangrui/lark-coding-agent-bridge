#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isWindows = platform() === 'win32';
const localTsup = join(rootDir, 'node_modules', '.bin', isWindows ? 'tsup.cmd' : 'tsup');
const forceNpmExec = process.env.LARK_CHANNEL_BRIDGE_FORCE_NPM_EXEC === '1';
const requiredDistFiles = ['cli.js', 'index.js', 'index.d.ts'].map((file) =>
  join(rootDir, 'dist', file),
);

if (!forceNpmExec && requiredDistFiles.every((file) => existsSync(file))) {
  process.exit(0);
}

const command = !forceNpmExec && existsSync(localTsup) ? localTsup : isWindows ? 'npm.cmd' : 'npm';
const args =
  command === localTsup
    ? []
    : [
        'exec',
        '--yes',
        '--package',
        'tsup@^8.3.5',
        '--package',
        'typescript@^5.6.3',
        '--',
        'tsup',
      ];

const result = spawnSync(command, args, {
  cwd: rootDir,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
