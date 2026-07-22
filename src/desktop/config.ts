import type { AppConfig } from '../config/schema';

export interface DesktopConfig {
  floatingBall?: {
    enabled?: boolean;
  };
}

export interface FloatingBallEnableInput {
  platform?: NodeJS.Platform;
  cfg?: Partial<AppConfig> & { desktop?: DesktopConfig };
  noFloatingBall?: boolean;
}

export function shouldEnableFloatingBall(input: FloatingBallEnableInput = {}): boolean {
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  if (input.noFloatingBall === true) return false;
  return input.cfg?.desktop?.floatingBall?.enabled !== false;
}
