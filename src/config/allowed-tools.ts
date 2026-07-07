export interface ToolCategory {
  name: string;
  tools: string[];
}

/**
 * Single source of truth for known Claude Code tool names, organized by
 * category for display. All tool references derive from here.
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  { name: '文件/目录', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'] },
  { name: '网络/搜索', tools: ['WebSearch', 'WebFetch', 'VaultHttpFetch'] },
  { name: '执行/Agent', tools: ['Bash', 'Agent', 'Skill', 'ExecuteExtraTool', 'SearchExtraTools'] },
  { name: '进程/调度', tools: ['Monitor', 'Sleep', 'Workflow'] },
  { name: '团队/消息', tools: ['SendMessage', 'TeamCreate', 'TeamDelete'] },
  { name: '任务/定时', tools: ['Task', 'TaskOutput', 'TaskStop', 'CronCreate', 'CronDelete', 'CronList'] },
  { name: '计划/模式', tools: ['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'] },
  { name: '其他', tools: ['AskUserQuestion', 'DiscoverSkills', 'GoalTool', 'ListMcpResourcesTool',
    'LocalMemoryRecall', 'ReadMcpResourceTool', 'RemoteTrigger', 'TodoWrite', 'artifact'] },
];

/**
 * Flat set of all known tool names, derived from {@link TOOL_CATEGORIES}.
 */
const CLAUDE_TOOL_NAMES: Set<string> = new Set(
  TOOL_CATEGORIES.flatMap((c) => c.tools),
);

/**
 * Prefix list for non-fixed (ToolName(filter)) patterns.
 * A tool name in `ToolName(filter)` is valid if its base name starts with
 * one of these prefixes. Derived from {@link CLAUDE_TOOL_NAMES}.
 */
const TOOL_PREFIXES = [...CLAUDE_TOOL_NAMES];

const TOOL_WITH_FILTER = /^([A-Za-z]\w+)\(([^)]*)\)$/; // ToolName(filter)

/**
 * Validate a user-supplied allowedTools string. Returns arrays of valid and
 * invalid tokens so the caller can give precise feedback.
 *
 * A token is valid if it is:
 * 1. A known Claude built-in tool name (case-sensitive, e.g. `Bash`)  — exact match
 * 2. A known tool name with a parenthesised filter (e.g. `Bash(git:*)`) — prefix match
 * 3. An MCP tool reference — bare `mcp__*` (silently ignored by the adapter)
 *    or `ExecuteExtraTool` (bare tool name)
 */
export function validateAllowedTools(input: string): {
  valid: string[];
  invalid: string[];
} {
  // Match tokens directly instead of splitting, so spaces inside
  // parentheses (e.g. Bash(lark-cli *)) aren't treated as delimiters.
  // Supports comma-separated, space-separated, or mixed input.
  const tokens = input.match(/[\w]+(?:\([^)]*\))?/g) ?? [];

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const token of tokens) {
    // MCP tool — accept by format
    if (token.startsWith('mcp__')) {
      valid.push(token);
      continue;
    }

    const match = token.match(TOOL_WITH_FILTER);
    if (match) {
      // ToolName(filter) — validate base name against prefix list
      const baseName = match[1]!;
      const matched = TOOL_PREFIXES.some((prefix) => baseName.startsWith(prefix));
      if (matched) {
        valid.push(token);
      } else {
        invalid.push(token);
      }
      continue;
    }

    // Plain tool name — exact match against known names
    if (CLAUDE_TOOL_NAMES.has(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }

  return { valid, invalid };
}
