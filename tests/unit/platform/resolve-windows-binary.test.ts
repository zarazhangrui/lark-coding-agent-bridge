import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node modules before importing
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));
vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { resolveWindowsBinary } from '../../../src/platform/resolve-windows-binary';

describe('resolveWindowsBinary', () => {
  const mockExec = vi.mocked(execFileSync);
  const mockRead = vi.mocked(readFileSync);
  const mockPlatform = vi.mocked(platform);

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns binary unchanged on non-Windows', () => {
    mockPlatform.mockReturnValue('linux');
    expect(resolveWindowsBinary('claude')).toBe('claude');
  });

  it('returns binary unchanged when where finds no .cmd', () => {
    mockPlatform.mockReturnValue('win32');
    mockExec.mockReturnValue('C:\\Users\\test\\npm\\claude.exe\r\n');
    expect(resolveWindowsBinary('claude')).toBe('claude');
  });

  it('resolves .cmd to .exe by parsing the shim', () => {
    mockPlatform.mockReturnValue('win32');
    mockExec.mockReturnValue('C:\\Users\\test\\npm\\claude.cmd\r\n');
    mockRead.mockReturnValue(
      '@ECHO off\r\n' +
      'GOTO start\r\n' +
      ':find_dp0\r\n' +
      'SET dp0=%~dp0\r\n' +
      'EXIT /b\r\n' +
      ':start\r\n' +
      'SETLOCAL\r\n' +
      'CALL :find_dp0\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "C:\\Users\\test\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
    );
    expect(resolveWindowsBinary('claude')).toBe(
      'C:\\Users\\test\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    );
  });

  it('returns original binary when .cmd parsing fails', () => {
    mockPlatform.mockReturnValue('win32');
    mockExec.mockReturnValue('C:\\Users\\test\\npm\\claude.cmd\r\n');
    mockRead.mockReturnValue('invalid content without exe path');
    expect(resolveWindowsBinary('claude')).toBe('claude');
  });

  it('returns original binary when where command fails', () => {
    mockPlatform.mockReturnValue('win32');
    mockExec.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(resolveWindowsBinary('claude')).toBe('claude');
  });

  it('returns custom binary unchanged', () => {
    mockPlatform.mockReturnValue('win32');
    expect(resolveWindowsBinary('/custom/path/claude.exe')).toBe('/custom/path/claude.exe');
  });
});
