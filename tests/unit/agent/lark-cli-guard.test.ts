import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { larkCliGuardDir, withLarkCliGuard } from '../../../src/agent/lark-cli-guard.js';

const SHIM = fileURLToPath(new URL('../../../bin/shims/lark-cli', import.meta.url));

describe('withLarkCliGuard', () => {
  it('prepends the shim dir to PATH', () => {
    const out = withLarkCliGuard({ FOO: 'bar' });
    expect(out.FOO).toBe('bar');
    expect(out.PATH?.startsWith(larkCliGuardDir())).toBe(true);
    expect(out.PATH).toContain(process.env.PATH ?? '');
  });
});

describe('lark-cli guard shim', () => {
  // A fake "real" lark-cli that just echoes the args it received, so we can see
  // exactly what the shim forwarded.
  const dir = mkdtempSync(join(tmpdir(), 'larkguard-'));
  const fakeReal = join(dir, 'lark-cli');
  writeFileSync(fakeReal, '#!/bin/sh\necho "FORWARDED: $*"\n');
  chmodSync(fakeReal, 0o755);
  const nodeDir = join(process.execPath, '..');
  // shim dir first (so `lark-cli` = shim), then the fake real, then node.
  const PATH = [larkCliGuardDir(), dir, nodeDir].join(delimiter);

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SHIM, ...args], {
      env: { ...process.env, PATH },
      encoding: 'utf8',
    });

  afterAll(() => {
    // mkdtemp dir is left for the OS to reap; nothing persistent created elsewhere.
  });

  it('rewrites an explicit --as user on an im send', () => {
    const r = run('im', 'send', '--chat', 'oc_x', '--text', 'hi', '--as', 'user');
    expect(r.stdout).toContain('FORWARDED: im send --chat oc_x --text hi --as bot');
    expect(r.stdout).not.toContain('--as user');
  });

  it('rewrites the --as=user form too', () => {
    const r = run('im', 'reply', '--as=user', '--text', 'hi');
    expect(r.stdout).toContain('--as=bot');
    expect(r.stdout).not.toContain('--as=user');
  });

  it('covers the raw `+messages-send` verb the prompt uses', () => {
    const r = run('im', '+messages-send', '--chat-id', 'oc_x', '--msg-type', 'text', '--as', 'user');
    expect(r.stdout).toContain('+messages-send');
    expect(r.stdout).toContain('--as bot');
    expect(r.stdout).not.toContain('--as user');
  });

  it('APPENDS --as bot when an im send has no identity flag (beats default-as auto)', () => {
    const r = run('im', '+messages-send', '--chat-id', 'oc_x', '--content', '{}');
    expect(r.stdout).toContain('FORWARDED: im +messages-send --chat-id oc_x --content {} --as bot');
  });

  it('leaves doc creation as the user untouched', () => {
    const r = run('docs', '+create', '--as', 'user', '--title', 'X');
    expect(r.stdout).toContain('FORWARDED: docs +create --as user --title X');
  });

  it('leaves a non-im command untouched', () => {
    const r = run('base', 'record', 'list', '--as', 'user');
    expect(r.stdout).toContain('FORWARDED: base record list --as user');
  });

  it('does not touch read-only im commands (no spurious --as bot)', () => {
    const r = run('im', 'chat-history', '--chat-id', 'oc_x');
    expect(r.stdout).toContain('FORWARDED: im chat-history --chat-id oc_x');
    expect(r.stdout).not.toContain('--as');
  });
});
