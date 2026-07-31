import { describe, expect, it } from 'vitest';
import { buildLeanAppServerArgs } from '../../../src/agent/codex/app-server-lean.js';

describe('buildLeanAppServerArgs', () => {
  it('disables MCP, Apps, plugins, browser/computer-use, permissions, and hooks locally', () => {
    const args = buildLeanAppServerArgs({
      mcp_servers: {
        'z.http': {
          url: 'https://secret.example.invalid/mcp',
          http_headers: { Authorization: 'Bearer fake-secret' },
        },
        'a"stdio\\server': {
          command: '/private/original-command',
          args: ['--token', 'fake-secret'],
          env: { TOKEN: 'fake-secret' },
        },
      },
    });

    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args).toContain('notify=[]');
    expect(args).toContain('include_apps_instructions=false');
    for (const feature of [
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
    ]) {
      expect(hasDisabledFeature(args, feature)).toBe(true);
    }
    expect(hasDisabledFeature(args, 'memories')).toBe(false);

    const override = args.find((arg) => arg.startsWith('mcp_servers={'));
    expect(override).toBe(
      'mcp_servers={"a\\"stdio\\\\server"={enabled=false,command="disabled-by-lark-channel-bridge"},"z.http"={enabled=false,url="http://127.0.0.1"}}',
    );
    const serialized = args.join('\n');
    expect(serialized).not.toContain('/private/original-command');
    expect(serialized).not.toContain('secret.example.invalid');
    expect(serialized).not.toContain('fake-secret');
  });

  it('omits an MCP override when the effective inventory is empty or damaged', () => {
    expect(buildLeanAppServerArgs().some((arg) => arg.startsWith('mcp_servers={'))).toBe(false);
    expect(
      buildLeanAppServerArgs({ mcp_servers: [] }).some((arg) =>
        arg.startsWith('mcp_servers={'),
      ),
    ).toBe(false);
  });
});

function hasDisabledFeature(args: string[], feature: string): boolean {
  return args.some((arg, index) => arg === '--disable' && args[index + 1] === feature);
}
