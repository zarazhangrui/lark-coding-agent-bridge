import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agent/pi/argv.js';

describe('Pi argv contract', () => {
  it('builds the fresh-run argv with no session, no tools restriction', () => {
    expect(buildPiArgs({ accessMode: 'full' })).toEqual(['--mode', 'json']);
  });

  it('adds --session when resuming', () => {
    expect(buildPiArgs({ accessMode: 'full', sessionId: 'sess-123' })).toEqual([
      '--mode',
      'json',
      '--session',
      'sess-123',
    ]);
  });

  it('restricts tools for read-only access', () => {
    expect(buildPiArgs({ accessMode: 'read-only' })).toEqual([
      '--mode',
      'json',
      '--tools',
      'read,grep,find,ls',
    ]);
  });

  it('does not restrict tools for workspace access (no native workspace sandbox in pi)', () => {
    expect(buildPiArgs({ accessMode: 'workspace' })).toEqual(['--mode', 'json']);
  });

  it('appends image attachments as @path argv tokens', () => {
    expect(
      buildPiArgs({ accessMode: 'full', images: ['/tmp/one.png', '/tmp/two.jpg'] }),
    ).toEqual(['--mode', 'json', '@/tmp/one.png', '@/tmp/two.jpg']);
  });

  it('combines session, read-only tools, and images in a stable order', () => {
    expect(
      buildPiArgs({
        accessMode: 'read-only',
        sessionId: 'sess-abc',
        images: ['/tmp/pic.png'],
      }),
    ).toEqual([
      '--mode',
      'json',
      '--session',
      'sess-abc',
      '--tools',
      'read,grep,find,ls',
      '@/tmp/pic.png',
    ]);
  });

  it('throws on an unrecognized access mode', () => {
    // @ts-expect-error deliberately invalid input
    expect(() => buildPiArgs({ accessMode: 'nonsense' })).toThrow(/unsafe access mode/);
  });
});
