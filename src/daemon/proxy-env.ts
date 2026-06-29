/**
 * Proxy env vars the daemon must inherit.
 *
 * launchd plists, systemd user units, and Windows scheduled tasks do NOT
 * read the user's shell rc (`.zshrc` / `.bashrc` / etc.), so any proxy the
 * user exported there is invisible to the service. The daemon — and the
 * agent CLI it spawns (claude / codex) — then make outbound calls with no
 * proxy. On networks that require one this fails silently: most painfully,
 * mainland-China hosts get a 403 geo-block on direct connections to the
 * model API, while the same command run from an interactive shell (which
 * inherits the rc proxy) works — making it very hard to diagnose.
 *
 * We snapshot these at service-install time and bake them into the service
 * definition, the same way PATH is captured. Both upper- and lower-case
 * spellings are honoured because different tools read different ones.
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

export interface EnvVar {
  key: string;
  value: string;
}

/**
 * Collect the proxy vars set in the current process environment, preserving
 * the canonical order above. Unset or empty vars are skipped, so a host with
 * no proxy configured yields `[]` and the service definition is unchanged.
 */
export function collectProxyEnv(env: NodeJS.ProcessEnv = process.env): EnvVar[] {
  const out: EnvVar[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      out.push({ key, value });
    }
  }
  return out;
}
