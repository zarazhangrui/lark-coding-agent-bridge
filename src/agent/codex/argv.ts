import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
  restrictedTask?: { research: boolean };
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (input.restrictedTask && (input.threadId || input.sandbox !== 'read-only')) {
    throw new Error('restricted tasks require a fresh read-only run');
  }
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    '-c',
    'approval_policy="never"',
    '-c',
    input.restrictedTask ? 'shell_environment_policy.inherit="none"' : 'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig === true || input.restrictedTask ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false && !input.restrictedTask ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
    ...(input.restrictedTask ? [
      '--ephemeral',
      '-c', 'features.shell_tool=false',
      '-c', 'features.apply_patch_freeform=false',
      '-c', 'features.view_image=false',
      '-c', 'features.code_mode=false',
      '-c', 'features.code_mode_only=false',
      '-c', 'features.browser_use=false',
      '-c', 'features.goals=false',
      '-c', 'features.image_generation=false',
      '-c', 'features.unified_exec=false',
      '-c', 'features.apps=false',
      '-c', 'features.hooks=false',
      '-c', 'features.multi_agent=false',
      '-c', 'features.multi_agent_v2=false',
      '-c', 'agents.enabled=false',
      '-c', 'features.skill_search=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'mcp_servers={}',
      '-c', 'plugins={}',
      '-c', 'memories.use_memories=false',
      '-c', 'memories.generate_memories=false',
      '-c', `web_search="${input.restrictedTask.research ? 'live' : 'disabled'}"`,
    ] : []),
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
