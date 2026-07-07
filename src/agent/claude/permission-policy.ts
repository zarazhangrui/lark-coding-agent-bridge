/**
 * Interactive-approval policy. We use a *whitelist* of known read-only tools
 * that auto-allow, and prompt for everything else (writes, external access,
 * unknown/MCP tools). Whitelist-not-blacklist means a newly introduced tool
 * defaults to prompting rather than silently auto-running.
 */
export const SAFE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite',
]);

export function classifyTool(toolName: string): 'auto-allow' | 'prompt' {
  return SAFE_READONLY_TOOLS.has(toolName) ? 'auto-allow' : 'prompt';
}
