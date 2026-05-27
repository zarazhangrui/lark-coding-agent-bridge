export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { ClaudeAdapter } from './claude/adapter';
export { CodexAdapter } from './codex/adapter';

import type { AgentKind } from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter } from './types';

const AGENT_FACTORIES = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
} satisfies Record<AgentKind, () => AgentAdapter>;

export function createAgent(kind: AgentKind): AgentAdapter {
  return AGENT_FACTORIES[kind]();
}
