import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the kimi CLI lives when a profile does not pin kimi.binaryPath:
 * LARK_CHANNEL_KIMI_BIN wins, otherwise the standard install location
 * ~/.kimi-code/bin/kimi (kimi is not expected on PATH).
 */
export function defaultKimiBinaryPath(): string {
  const override = process.env.LARK_CHANNEL_KIMI_BIN?.trim();
  return override || join(homedir(), '.kimi-code', 'bin', 'kimi');
}
