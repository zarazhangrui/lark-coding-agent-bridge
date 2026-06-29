// The bridge process exports LARK_CHANNEL* / LARKSUITE_CLI_CONFIG_DIR into
// `process.env`. Spawns spread `process.env`, leaking these vars into cases
// that assert a clean native env (e.g. lark-cli `config show` run without the
// bridge config). Strip them per-test and restore after so assertions see a
// deterministic env. Shared by preflight + integration tests that spawn lark-cli.
//
// `savedBridgeEnv` is module-level but safe across test files: vitest isolates
// each test file in its own worker, so every file gets an independent module
// instance.

export const BRIDGE_ENV_VARS = [
  'LARK_CHANNEL',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_PROFILE',
  'LARKSUITE_CLI_CONFIG_DIR',
] as const;

let savedBridgeEnv: Record<string, string | undefined> | undefined;

export function isolateBridgeEnv(): void {
  savedBridgeEnv = {};
  for (const key of BRIDGE_ENV_VARS) {
    savedBridgeEnv[key] = process.env[key];
    delete process.env[key];
  }
}

export function restoreBridgeEnv(): void {
  if (!savedBridgeEnv) return;
  for (const key of BRIDGE_ENV_VARS) {
    const value = savedBridgeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedBridgeEnv = undefined;
}
