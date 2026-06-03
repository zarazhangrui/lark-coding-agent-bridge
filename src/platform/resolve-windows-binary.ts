import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * On Windows, npm installs `.cmd` shims that wrap the real `.exe`.
 * When cross-spawn runs a `.cmd` file, it wraps the invocation with
 * `cmd.exe /d /s /c "..."`, which corrupts multi-line arguments
 * (e.g. prompts containing `\n`). This causes downstream tools like
 * Claude Code to receive garbled `--output-format` flags and fall
 * back to plain-text output instead of structured JSON.
 *
 * This helper resolves a `.cmd` shim to its underlying `.exe` so that
 * cross-spawn can execute the binary directly, bypassing cmd.exe.
 */
export function resolveWindowsBinary(binary: string): string {
  if (platform() !== 'win32') return binary;

  try {
    const whereOutput = execFileSync('where', [binary], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cmdPath = whereOutput.trim().split(/\r?\n/)[0]?.trim();
    if (!cmdPath || !cmdPath.toLowerCase().endsWith('.cmd')) return binary;

    // npm .cmd shims contain the real .exe path in the last line:
    // endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "path\to\exe" %*
    const content = readFileSync(cmdPath, 'utf8');
    const match = content.match(/"([^"]+\.exe)"/i);
    return match ? match[1] : binary;
  } catch {
    return binary;
  }
}
