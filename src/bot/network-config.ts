import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log } from '../core/logger';

const HTTP_TIMEOUT_MS = 30_000;

/**
 * Wire up HTTP / WS networking knobs. Called once at startup.
 *
 *  - **HTTP timeout** — mutate SDK's `defaultHttpInstance.defaults.timeout`
 *    so every outbound REST call gets a 30s cap. Without this a slow API
 *    can hang the whole event-handling thread.
 *  - **HTTP(S) proxy** — if `HTTPS_PROXY` / `HTTP_PROXY` env is set and the
 *    target Feishu/Lark API host is not covered by `NO_PROXY`, attach
 *    `HttpsProxyAgent` to both axios (`defaults.httpsAgent`) and WSClient
 *    (`channel.opts.agent`, returned for caller to spread).
 *
 * Returns `{ agent }` when proxy is configured (for `LarkChannelOptions.agent`),
 * empty object otherwise.
 */
export interface NetworkOverrides {
  agent?: HttpsProxyAgent<string>;
}

export interface NetworkOptions {
  /** Feishu/Lark API host or URL this channel talks to. Used for NO_PROXY. */
  apiHost?: string;
}

export function configureNetwork(opts: NetworkOptions = {}): NetworkOverrides {
  // Mutate SDK's axios instance defaults. The exported HttpInstance type
  // hides axios's `defaults` field, but the runtime IS a full axios.
  const ax = defaultHttpInstance as unknown as {
    defaults: { timeout?: number; httpsAgent?: unknown };
  };
  ax.defaults.timeout = HTTP_TIMEOUT_MS;

  const proxyUrl = process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy;
  if (!proxyUrl) {
    ax.defaults.httpsAgent = undefined;
    return {};
  }

  const host = normalizeHost(opts.apiHost);
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (host && shouldBypassProxy(host, noProxy)) {
    ax.defaults.httpsAgent = undefined;
    log.info('network', 'proxy-bypassed', { host, noProxy });
    return {};
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  ax.defaults.httpsAgent = agent;
  log.info('network', 'proxy-detected', { proxy: redact(proxyUrl), host });

  return { agent };
}

export function shouldBypassProxy(host: string, noProxy: string): boolean {
  const normalizedHost = stripPort(host.trim().toLowerCase());
  if (!normalizedHost) return false;
  const entries = noProxy
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return entries.some((entry) => {
    if (entry === '*') return true;
    const token = stripPort(entry);
    if (!token) return false;
    if (token.startsWith('.')) {
      const suffix = token.slice(1);
      return normalizedHost === suffix || normalizedHost.endsWith(token);
    }
    return normalizedHost === token || normalizedHost.endsWith(`.${token}`);
  });
}

function normalizeHost(input: string | undefined): string | undefined {
  if (!input) return undefined;
  try {
    return stripPort(new URL(input).host.toLowerCase());
  } catch {
    return stripPort(input.toLowerCase());
  }
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  return host.split(':')[0] ?? '';
}

function redact(url: string): string {
  return url.replace(/\/\/[^:@/]+:[^@/]+@/, '//[redacted]@');
}
