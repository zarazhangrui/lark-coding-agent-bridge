import type { AgentKind } from '../config/profile-schema';

export const DEFAULT_EFFORT = 'default';
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_OPTIONS: { value: ClaudeEffortLevel | typeof DEFAULT_EFFORT; label: string }[] = [
  { value: DEFAULT_EFFORT, label: '跟随默认（不指定）' },
  { value: 'low', label: 'Low（低）' },
  { value: 'medium', label: 'Medium（中）' },
  { value: 'high', label: 'High（高）' },
  { value: 'xhigh', label: 'XHigh（更高）' },
  { value: 'max', label: 'Max（最高）' },
];

export function supportedEfforts(): typeof EFFORT_OPTIONS {
  return EFFORT_OPTIONS;
}

export function normalizeEffortSelection(
  value: string | undefined,
): ClaudeEffortLevel | typeof DEFAULT_EFFORT {
  return EFFORT_OPTIONS.find((option) => option.value === value)?.value ?? DEFAULT_EFFORT;
}

export function resolveEffortArg(
  agentKind: AgentKind,
  value: string | undefined,
): ClaudeEffortLevel | undefined {
  if (agentKind !== 'claude') return undefined;
  const selection = normalizeEffortSelection(value);
  return selection === DEFAULT_EFFORT ? undefined : selection;
}

export function effortLabel(value: string | undefined): string {
  const selection = normalizeEffortSelection(value);
  return EFFORT_OPTIONS.find((option) => option.value === selection)?.label ?? '跟随默认（不指定）';
}
