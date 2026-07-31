export interface CodexAppServerConfigInventory {
  features?: readonly string[];
  mcp_servers?: unknown;
}

const DISABLED_FEATURES = [
  'apps',
  'enable_mcp_apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'request_permissions_tool',
  'hooks',
] as const;

/**
 * App-server shares the user's CODEX_HOME so its durable threads remain
 * discoverable by Codex App. These process-local overrides remove desktop-only
 * hooks and tool surfaces without rewriting the user's config.toml.
 */
export function buildLeanAppServerArgs(inventory?: CodexAppServerConfigInventory): string[] {
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'shell_environment_policy.inherit="all"',
    '-c',
    'notify=[]',
    '-c',
    'include_apps_instructions=false',
  ];
  const supportedFeatures = new Set(inventory?.features ?? []);
  for (const feature of DISABLED_FEATURES) {
    if (supportedFeatures.has(feature)) args.push('--disable', feature);
  }

  const mcpOverride = disabledMcpServersOverride(inventory?.mcp_servers);
  if (mcpOverride) args.push('-c', mcpOverride);
  return args;
}

export function parseCodexFeatureList(output: string): string[] {
  const features = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z][a-z0-9_]*)\s+.+\s+(?:true|false)$/);
    if (match?.[1]) features.add(match[1]);
  }
  return [...features];
}

export function assertMcpServersDisabled(input: unknown): void {
  if (input === undefined || input === null) return;
  const servers = recordValue(input);
  if (!servers) throw new Error('codex app-server returned a malformed mcp_servers inventory');
  const enabled = Object.entries(servers)
    .filter(([, value]) => recordValue(value)?.enabled !== false)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  if (enabled.length > 0) {
    throw new Error(`codex app-server loaded MCP servers that are not disabled: ${enabled.join(', ')}`);
  }
}

function disabledMcpServersOverride(input: unknown): string | undefined {
  const servers = recordValue(input);
  if (!servers) return undefined;
  const entries = Object.entries(servers)
    .filter(([, value]) => recordValue(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const config = recordValue(value);
      const dummyTransport = typeof config?.url === 'string'
        ? 'url="http://127.0.0.1"'
        : 'command="disabled-by-lark-channel-bridge"';
      return `${tomlString(name)}={enabled=false,${dummyTransport}}`;
    });
  return entries.length > 0 ? `mcp_servers={${entries.join(',')}}` : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
