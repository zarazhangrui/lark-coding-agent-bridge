import { randomUUID } from 'node:crypto';
import { link, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface InitializeControllerWorkspaceOptions {
  workspace: string;
  force?: boolean;
}

export interface InitializeControllerWorkspaceResult {
  workspace: string;
  created: string[];
  skipped: string[];
}

const AGENTS_CONTENT = `# 飞书 Codex 主控工作区

本目录用于维护一个长期存在的飞书主控 task。

## 职责

- 普通飞书消息默认由当前主 task 处理。
- 涉及具体代码仓库的实现、测试或 review，优先创建或恢复该仓库对应的 worker task。
- task 管理必须使用 \`codex-task-controller\` Skill 和 Bridge 提供的 \`codex-task\` 命令。
- 不直接修改 Codex rollout JSONL、SQLite 或 session index。
- 不同时从 Bridge 和 Codex App 写入同一个 task。
- 读取其他 task 时先读取元数据和摘要，仅在必要时读取完整 turns。
- worker 完成后，将结果汇总回当前主 task。

## 工作目录

- 主 task 的 cwd 始终保持为本目录。
- “切换项目”表示选择 worker 的目标项目，不修改主 task 的真实 cwd。
- worker task 使用目标项目的真实绝对路径作为 cwd。
`;

const SKILL_CONTENT = `---
name: codex-task-controller
description: Use when the user asks to list, inspect, create, resume, or send work to persistent Codex tasks from the fixed Lark controller workspace.
---

# Codex Task Controller

Use the local \`lark-channel-bridge codex-task\` control plane for every cross-task operation.

## Boundaries

1. Never edit Codex rollout JSONL, SQLite, or session index files directly.
2. Use user-facing task handles such as \`T-A1B2C3\`; do not expose raw thread IDs unless diagnosing locally.
3. Read task metadata before sending work.
4. Do not send work when the target is already being written by Codex App.
5. Never dispatch work back to the current controller task.
6. Do not delete or archive tasks; this MVP intentionally has no destructive command.

## Profile selection

When \`LARK_CHANNEL_PROFILE\` is set, pass \`--profile "$LARK_CHANNEL_PROFILE"\`.
Otherwise ask for the profile name instead of guessing when more than one profile exists.

Preserve the exact Bridge root config without reusing \`LARK_CHANNEL_CONFIG\`, which belongs to
the lark-cli source projection:

\`\`\`bash
bridge_config_args=()
if [[ -n "\${LARK_CHANNEL_BRIDGE_CONFIG:-}" ]]; then
  bridge_config_args=(--config "$LARK_CHANNEL_BRIDGE_CONFIG")
fi
\`\`\`

## Commands

List registered worker tasks:

\`\`\`bash
lark-channel-bridge codex-task list "\${bridge_config_args[@]}" --profile "$LARK_CHANNEL_PROFILE" --json
\`\`\`

Create an empty persistent worker task:

\`\`\`bash
lark-channel-bridge codex-task create "\${bridge_config_args[@]}" --profile "$LARK_CHANNEL_PROFILE" --title "<title>" --cwd "<absolute-path>" --json
\`\`\`

Create a worker and immediately give it work:

\`\`\`bash
lark-channel-bridge codex-task create "\${bridge_config_args[@]}" --profile "$LARK_CHANNEL_PROFILE" --title "<title>" --cwd "<absolute-path>" --message "<instruction>" --json
\`\`\`

Read a worker without resuming it:

\`\`\`bash
lark-channel-bridge codex-task read <handle> "\${bridge_config_args[@]}" --profile "$LARK_CHANNEL_PROFILE" --json
\`\`\`

Send additional work and wait for the turn to finish:

\`\`\`bash
lark-channel-bridge codex-task send <handle> "\${bridge_config_args[@]}" --profile "$LARK_CHANNEL_PROFILE" --message "<instruction>" --json
\`\`\`

After a command finishes, report the handle, title, cwd, model, status, and result. Keep long histories summarized unless the user asks for full detail.
`;

export async function initializeControllerWorkspace(
  options: InitializeControllerWorkspaceOptions,
): Promise<InitializeControllerWorkspaceResult> {
  const workspace = options.workspace;
  const files = [
    { path: join(workspace, 'AGENTS.md'), content: AGENTS_CONTENT },
    {
      path: join(workspace, '.agents', 'skills', 'codex-task-controller', 'SKILL.md'),
      content: SKILL_CONTENT,
    },
  ];
  const result: InitializeControllerWorkspaceResult = { workspace, created: [], skipped: [] };
  await mkdir(workspace, { recursive: true });
  for (const file of files) {
    if (!options.force) {
      try {
        await writeFileAtomicNoClobber(file.path, file.content, 0o644);
        result.created.push(file.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        result.skipped.push(file.path);
      }
    } else {
      await writeFileAtomic(file.path, file.content, { mode: 0o644 });
      result.created.push(file.path);
    }
  }
  return result;
}

async function writeFileAtomicNoClobber(path: string, content: string, mode: number): Promise<void> {
  const candidate = `${path}.new-${randomUUID()}`;
  try {
    await writeFileAtomic(candidate, content, { mode });
    await link(candidate, path);
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined);
  }
}
