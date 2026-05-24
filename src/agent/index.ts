export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { ClaudeAdapter } from './claude/adapter';
export { CodexAdapter } from './codex/adapter';

import type { AgentKind } from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter } from './types';

export function createAgent(kind: AgentKind): AgentAdapter {
  return kind === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
}
