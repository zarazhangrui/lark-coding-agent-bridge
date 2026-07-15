import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CodexAdapter generated image directory', () => {
  it('uses an explicit Codex home when configured', () => {
    const adapter = new CodexAdapter({
      binary: '/bin/codex',
      profileStateDir: '/profile',
      codexHome: '/custom-codex-home',
    });
    expect(adapter.getGeneratedImagesDir()).toBe(join('/custom-codex-home', 'generated_images'));
  });

  it('uses the profile-local Codex home when inheritance is disabled', () => {
    const adapter = new CodexAdapter({
      binary: '/bin/codex',
      profileStateDir: '/profile',
      inheritCodexHome: false,
    });
    expect(adapter.getGeneratedImagesDir()).toBe(
      join('/profile', 'codex-home', 'generated_images'),
    );
  });

  it('uses inherited CODEX_HOME when no profile override is configured', () => {
    vi.stubEnv('CODEX_HOME', '/env-codex-home');
    const adapter = new CodexAdapter({
      binary: '/bin/codex',
      profileStateDir: '/profile',
    });
    expect(adapter.getGeneratedImagesDir()).toBe(join('/env-codex-home', 'generated_images'));
  });
});
