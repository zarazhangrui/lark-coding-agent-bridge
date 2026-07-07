# Phase 1b：飞书审批卡片 + auto 权限模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1a 造好的交互审批机制接到飞书侧（独立审批卡片 + 签名按钮回传），并把 `auto` 权限模式设为 `full` 访问的新默认（分类器把关、疑难弹卡、拒绝留注记）。

**Architecture:** 适配器在 `settle()` 漏斗新增 `permission_resolved` 事件作为唯一时间权威；新模块 `src/card/approval-card.ts`（卡片构建器 + `ApprovalCardTracker`，IO 注入、可独立单测）；`processAgentStream` 增加可选 `approvals` 钩子并在循环结束兜底清扫；按钮走既有 `bridge_token` 签名 + `perm` 命令处理器（仅限卡片点击）回传 `respondPermission`。`permissions.ts` 加入 `'auto'` 并变更 full 默认映射。

**Tech Stack:** TypeScript (ESM, strict)、Node ≥ 20.12.0、`@anthropic-ai/claude-agent-sdk` v0.3.x（已在依赖中）、vitest、pnpm。

## Global Constraints

- Node.js ≥ 20.12.0；纯 ESM；测试内相对 import 带 `.js` 扩展名，src 内跟随同目录既有风格（`src/agent/claude/` 与 `src/card/` 均为无扩展名相对 import）。
- TypeScript strict；不得引入本计划未定义的类型/函数；无 TBD/TODO 占位。
- vitest；纯函数/模块测试放 `tests/unit/`，进程/适配器测试放 `tests/process/`。
- 提交信息结尾：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- SDK 事实（已对出厂 `sdk.d.ts` 核实）：`PermissionMode` 联合含 `'auto'`（sdk.d.ts:2039）；分类器拒绝消息形状为 `{ type:'system', subtype:'permission_denied', tool_name: string, tool_use_id: string, decision_reason?: string, message: string, … }`。
- 行为变更（spec §2 已批准）：`full` 访问的默认 Claude 权限模式由 `bypassPermissions` 改为 `auto`；显式覆盖回 bypass 的既有机制（`permissions.claude.permissionMode`）保留。
- 审批超时默认 5 分钟；`claude.approvalTimeoutMinutes` 可配（profile）。
- 审批回传仅允许卡片按钮（`ctx.fromCardAction === true`），文本命令 `/perm …` 必须拒绝——否则绕过 `bridge_token` 签名校验。

---

## File Structure

- Modify `src/config/permissions.ts` — `ClaudePermissionMode` 加 `'auto'`；`CLAUDE_PERMISSION_ACCESS` 加 `auto:'full'`；`accessToDefaultClaudePermissionMode` 的 `full` 分支改 `'auto'`；`isClaudePermissionMode` 守卫加 `'auto'`。
- Modify `src/config/profile-schema.ts` — 新增 `claude?: { env?: Record<string,string>; approvalTimeoutMinutes?: number }` 字段与 normalize。
- Modify `src/agent/types.ts` — `AgentEvent` 加 `permission_resolved` 与 `notice` 两个成员。
- Modify `src/agent/claude/sdk-adapter.ts` — `settle()` 发 `permission_resolved`。
- Modify `src/agent/claude/sdk-translate.ts` — `permission_denied` → `notice`。
- Modify `src/card/run-state.ts` — `reduce` 加 `notice` 分支（追加非流式文本块）。
- Create `src/card/approval-card.ts` — 卡片构建器 + `ApprovalCardTracker`。
- Modify `src/bot/channel.ts` — `processAgentStream` 加 `approvals` 钩子与看门狗暂停；`runAgentBatch` 构建 tracker 并传入。
- Modify `src/commands/index.ts` — 注册 `/perm` 处理器（仅卡片点击）。
- Modify `src/cli/commands/start.ts` — `createRuntimeAgent` 传 `approvalEnabled: true`、`env`、`permissionTimeoutMs`。
- Create `docs/superpowers/verification/2026-07-07-phase1b-smoke.md` — 真机冒烟 checklist（用户执行）。
- Create `docs/superpowers/specs/2026-07-07-phase2-steering-gate-findings.md` — Phase 2 入场门实验纪要。
- Tests: `tests/unit/config/permissions-auto.test.ts`、`tests/unit/config/profile-schema.test.ts`（若无则建）、`tests/process/claude-sdk-adapter.test.ts`（追加）、`tests/unit/agent/claude/sdk-translate.test.ts`（追加）、`tests/unit/card/run-state-notice.test.ts`、`tests/unit/card/approval-card.test.ts`、`tests/unit/commands/perm-handler.test.ts`、`tests/unit/agent/claude/permission-policy.test.ts`（追加直接断言）。

---

## Task 1: `auto` 权限模式（permissions.ts）

**Files:**
- Modify: `src/config/permissions.ts:3,33-38,122-131,278-285`
- Test: `tests/unit/config/permissions-auto.test.ts`（新建）

**Interfaces:**
- Produces: `ClaudePermissionMode` 联合新增 `'auto'`；`accessToClaudePermissionMode('full' …)` 无覆盖时返回 `'auto'`。后续任务依赖：`auto` 被钳制表视为 `full` 级别。

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/permissions-auto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  accessToClaudePermissionMode,
  normalizePermissions,
} from '../../../src/config/permissions.js';

describe('auto permission mode', () => {
  it('maps full access to auto by default', () => {
    expect(accessToClaudePermissionMode('full')).toBe('auto');
  });

  it('keeps read-only and workspace mappings unchanged', () => {
    expect(accessToClaudePermissionMode('read-only')).toBe('plan');
    expect(accessToClaudePermissionMode('workspace')).toBe('acceptEdits');
  });

  it('honors an explicit bypassPermissions override under full access', () => {
    expect(
      accessToClaudePermissionMode('full', {
        defaultAccess: 'full',
        maxAccess: 'full',
        claude: { permissionMode: 'bypassPermissions' },
      }),
    ).toBe('bypassPermissions');
  });

  it('accepts auto as an explicit permissionMode override', () => {
    const { permissions } = normalizePermissions({
      permissions: { defaultAccess: 'full', maxAccess: 'full', claude: { permissionMode: 'auto' } },
    });
    expect(permissions.claude?.permissionMode).toBe('auto');
  });

  it('rejects auto override when maxAccess is below full', () => {
    expect(() =>
      normalizePermissions({
        permissions: { defaultAccess: 'workspace', maxAccess: 'workspace', claude: { permissionMode: 'auto' } },
      }),
    ).toThrow(/cannot exceed maxAccess/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/config/permissions-auto.test.ts`
Expected: FAIL（`full` 返回 `bypassPermissions`；`'auto'` 被守卫拒绝）。

- [ ] **Step 3: Implement**

`src/config/permissions.ts` 四处修改：

```ts
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
```

```ts
const CLAUDE_PERMISSION_ACCESS: Record<ClaudePermissionMode, AccessMode> = {
  plan: 'read-only',
  default: 'workspace',
  acceptEdits: 'workspace',
  bypassPermissions: 'full',
  // auto lets the model classifier approve dangerous operations on its own,
  // so it requires the same access ceiling as bypass.
  auto: 'full',
};
```

```ts
function accessToDefaultClaudePermissionMode(access: AccessMode): ClaudePermissionMode {
  switch (access) {
    case 'read-only':
      return 'plan';
    case 'workspace':
      return 'acceptEdits';
    case 'full':
      return 'auto';
  }
}
```

```ts
function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'auto'
  );
}
```

不改 `src/agent/types.ts` 的 `CLAUDE_DEFAULT_PERMISSION_MODE`（仍为 `bypassPermissions`）：它只是适配器在调用方**未传** `permissionMode` 时的兜底（直跑/doctor 场景），生产模式一律由 run-policy 计算传入。

- [ ] **Step 4: Run test + sweep stale expectations**

Run: `pnpm vitest run tests/unit/config/permissions-auto.test.ts && pnpm test`
第一条应 PASS。全量跑完后若有既有测试断言 `full → bypassPermissions`（用 `grep -rn "bypassPermissions" tests/ | grep -v sdk-adapter` 排查），把这些期望改为 `'auto'`——它们断言的是默认映射，而默认映射已按 spec 变更。**不得**改动 `tests/process/claude-sdk-adapter.test.ts` 中显式传入 bypass 的用例。

- [ ] **Step 5: Commit**

```bash
git add src/config/permissions.ts tests/
git commit -m "feat(permissions): add auto mode, default full access to auto

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `claude` profile 配置字段

**Files:**
- Modify: `src/config/profile-schema.ts`
- Test: `tests/unit/config/profile-schema.test.ts`（存在则追加，不存在则新建）

**Interfaces:**
- Produces: `ProfileConfig.claude?: ClaudeConfig`，其中 `interface ClaudeConfig { env?: Record<string, string>; approvalTimeoutMinutes?: number }`。Task 6/7 依赖 `profileConfig.claude?.env` 与 `profileConfig.claude?.approvalTimeoutMinutes`。

- [ ] **Step 1: Write the failing test**

在 `tests/unit/config/profile-schema.test.ts` 追加（文件不存在则新建，import 对齐同目录既有测试）：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';

describe('claude profile config', () => {
  const base = { agentKind: 'claude' as const };

  it('accepts claude.env and claude.approvalTimeoutMinutes', () => {
    const cfg = normalizeProfileConfig({
      ...base,
      claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, approvalTimeoutMinutes: 10 },
    });
    expect(cfg.claude?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(cfg.claude?.approvalTimeoutMinutes).toBe(10);
  });

  it('omits claude when not configured', () => {
    expect(normalizeProfileConfig(base).claude).toBeUndefined();
  });

  it('rejects invalid env keys and non-positive timeout', () => {
    expect(() => normalizeProfileConfig({ ...base, claude: { env: { 'BAD=KEY': 'x' } } })).toThrow();
    expect(() => normalizeProfileConfig({ ...base, claude: { approvalTimeoutMinutes: 0 } })).toThrow();
    expect(() => normalizeProfileConfig({ ...base, claude: { approvalTimeoutMinutes: -1 } })).toThrow();
  });
});
```

> 注：`normalizeProfileConfig` 是该文件的规范化入口——实现前先打开 `src/config/profile-schema.ts` 确认导出名与最小合法输入形状（若入口名不同或必填字段更多，按既有测试文件的构造方式对齐；测试意图不变）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/config/profile-schema.test.ts`
Expected: FAIL（`claude` 字段未定义/被拒绝）。

- [ ] **Step 3: Implement**

`src/config/profile-schema.ts`：

```ts
export interface ClaudeConfig {
  env?: Record<string, string>;
  approvalTimeoutMinutes?: number;
}
```

在 `ProfileConfig`（及其 raw 输入类型）加 `claude?: ClaudeConfig;`（紧邻既有 `codex?: CodexConfig;`），在主 normalize 流程中加：

```ts
...(raw.claude !== undefined ? { claude: normalizeClaude(raw.claude) } : {}),
```

```ts
function normalizeClaude(input: unknown): ClaudeConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid claude config');
  }
  const raw = input as { env?: unknown; approvalTimeoutMinutes?: unknown };
  const env = normalizeClaudeEnv(raw.env);
  const approvalTimeoutMinutes = normalizeApprovalTimeout(raw.approvalTimeoutMinutes);
  const out: ClaudeConfig = {
    ...(env ? { env } : {}),
    ...(approvalTimeoutMinutes !== undefined ? { approvalTimeoutMinutes } : {}),
  };
  return out;
}

function normalizeClaudeEnv(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid claude.env config');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || /[\0=\r\n]/.test(normalizedKey)) {
      throw new Error('invalid claude.env key');
    }
    if (value === undefined || value === null) continue;
    const normalizedValue = String(value);
    if (!normalizedValue) continue;
    env[normalizedKey] = normalizedValue;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeApprovalTimeout(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('invalid claude.approvalTimeoutMinutes');
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/config/profile-schema.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config/profile-schema.ts tests/unit/config/profile-schema.test.ts
git commit -m "feat(config): add claude profile section (env, approvalTimeoutMinutes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `permission_resolved` 契约事件（types + adapter）

**Files:**
- Modify: `src/agent/types.ts`（`AgentEvent` 联合）
- Modify: `src/agent/claude/sdk-adapter.ts`（`settle()`）
- Test: `tests/process/claude-sdk-adapter.test.ts`（追加）、`tests/unit/agent/claude/permission-policy.test.ts`（追加直接断言）

**Interfaces:**
- Produces: `AgentEvent` 新成员
  `{ type: 'permission_resolved'; id: string; decision: 'allow' | 'deny'; reason: 'user' | 'timeout' | 'aborted' }`。
  Task 5/6 依赖此形状。适配器仅对**曾泊停**的请求发此事件（auto-allow 与未启用审批的立即拒绝不发）。

- [ ] **Step 1: Write the failing test**

追加到 `tests/process/claude-sdk-adapter.test.ts`（复用文件内既有 `approvalQuery`/fake 模式；三条 reason 路径）：

```ts
describe('permission_resolved emission', () => {
  it('emits user-reason after respondPermission', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery(), approvalEnabled: true });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it2 = run.events[Symbol.asyncIterator]();
    const first = await it2.next(); // permission_request
    expect(first.value).toMatchObject({ type: 'permission_request', id: 'tu-1' });
    run.respondPermission!('tu-1', 'allow');
    const collected: string[] = [];
    for (let n = await it2.next(); !n.done; n = await it2.next()) {
      collected.push(JSON.stringify(n.value));
    }
    expect(collected.some((s) => s.includes('"permission_resolved"') && s.includes('"user"') && s.includes('"allow"'))).toBe(true);
  });

  it('emits timeout-reason when the park times out', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery(), approvalEnabled: true, permissionTimeoutMs: 20 });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const events: string[] = [];
    for await (const e of run.events) events.push(JSON.stringify(e));
    expect(events.some((s) => s.includes('"permission_resolved"') && s.includes('"timeout"') && s.includes('"deny"'))).toBe(true);
  });

  it('emits aborted-reason when stopped mid-park', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery(), approvalEnabled: true });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it2 = run.events[Symbol.asyncIterator]();
    await it2.next(); // permission_request
    await run.stop();
    const rest: string[] = [];
    for (let n = await it2.next(); !n.done; n = await it2.next()) rest.push(JSON.stringify(n.value));
    // The abort force-resolve settles before the queue closes, so the event
    // is observable on the raw adapter stream (run-executor truncation is a
    // consumer-side concern covered by the channel sweep in Task 6).
    expect(rest.some((s) => s.includes('"permission_resolved"') && s.includes('"aborted"'))).toBe(true);
  });
});
```

追加到 `tests/unit/agent/claude/permission-policy.test.ts`（Phase 1a 遗留 Minor）：

```ts
it('pins the exact whitelist contents', () => {
  expect([...SAFE_READONLY_TOOLS].sort()).toEqual(
    ['Glob', 'Grep', 'LS', 'NotebookRead', 'Read', 'TodoWrite'].sort(),
  );
});
```

（并把 `SAFE_READONLY_TOOLS` 加进该文件 import。）

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts tests/unit/agent/claude/permission-policy.test.ts`
Expected: `permission_resolved` 三条 FAIL（事件不存在）；白名单断言 PASS 或随 import 修正后 PASS。

- [ ] **Step 3: Implement**

`src/agent/types.ts`：在 `permission_request` 成员之后加：

```ts
  | {
      type: 'permission_resolved';
      id: string;
      decision: 'allow' | 'deny';
      reason: 'user' | 'timeout' | 'aborted';
    }
```

`src/agent/claude/sdk-adapter.ts`：给 `settle` 增加 reason 形参并在收尾时发事件（保持单一漏斗；`pushEvent` 在 `closeQueue` 之前调用，drain-finally 的强制收尾也满足此序）：

```ts
    const settle = (
      id: string,
      result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string },
      reason: 'user' | 'timeout' | 'aborted',
    ): void => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      controller.signal.removeEventListener('abort', p.onAbort);
      p.resolve(result);
      pushEvent({ type: 'permission_resolved', id, decision: result.behavior, reason });
    };
```

四处调用点补 reason：`respondPermission` → `'user'`；超时定时器 → `'timeout'`；`onAbort` → `'aborted'`；drain-finally 的 run-ended 强制收尾 → `'aborted'`。auto-allow 与"未启用审批立即拒绝"两条早退路径不经过 `settle`，天然不发事件——保持现状。

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts tests/unit/agent/claude/permission-policy.test.ts && pnpm typecheck`
Expected: 全 PASS（既有用例不得被削弱；若既有"auto-denies when stopped"用例因新增事件而多收到一条，放宽其收集断言以容纳 `permission_resolved`，不得删除原断言意图）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/claude/sdk-adapter.ts tests/
git commit -m "feat(claude): emit permission_resolved from the settle funnel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 分类器拒绝注记（notice 事件）

**Files:**
- Modify: `src/agent/types.ts`、`src/agent/claude/sdk-translate.ts`、`src/card/run-state.ts`
- Test: `tests/unit/agent/claude/sdk-translate.test.ts`（追加）、`tests/unit/card/run-state-notice.test.ts`（新建）

**Interfaces:**
- Produces: `AgentEvent` 新成员 `{ type: 'notice'; text: string }`；`translateSdkMessage` 对 `{type:'system', subtype:'permission_denied'}` 产出 notice；`reduce` 对 notice 追加非流式文本块。

- [ ] **Step 1: Write the failing tests**

追加到 `tests/unit/agent/claude/sdk-translate.test.ts`：

```ts
it('maps permission_denied to a notice event', () => {
  expect(
    translateSdkMessage({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu-9',
      decision_reason: 'classifier judged the command destructive',
      message: 'Permission denied',
    }),
  ).toEqual([
    { type: 'notice', text: '工具 Bash 被自动拒绝：classifier judged the command destructive' },
  ]);
});

it('falls back to message when decision_reason is absent', () => {
  const out = translateSdkMessage({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Write',
    tool_use_id: 'tu-10',
    message: 'Permission denied',
  });
  expect(out).toEqual([{ type: 'notice', text: '工具 Write 被自动拒绝：Permission denied' }]);
});
```

Create `tests/unit/card/run-state-notice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state.js';

describe('run-state notice', () => {
  it('appends a non-streaming text block and closes streaming text', () => {
    let state = reduce(initialState, { type: 'text', delta: 'partial' });
    state = reduce(state, { type: 'notice', text: '工具 Bash 被自动拒绝：x' });
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: 'text', streaming: false });
    expect(state.blocks[1]).toMatchObject({
      kind: 'text',
      streaming: false,
      content: '_⛔ 工具 Bash 被自动拒绝：x_',
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/unit/agent/claude/sdk-translate.test.ts tests/unit/card/run-state-notice.test.ts`
Expected: FAIL（notice 不存在）。

- [ ] **Step 3: Implement**

`src/agent/types.ts`：`permission_resolved` 成员之后加 `| { type: 'notice'; text: string }`。

`src/agent/claude/sdk-translate.ts`：`SdkRawMessage` 接口补 `tool_name?: string; decision_reason?: string;`（`message` 字段与既有 `message?: { content?: ContentBlock[] }` 冲突——`permission_denied` 的 `message` 是 string。将接口内 `message` 类型放宽为 `{ content?: ContentBlock[] } | string`，读取处按 `typeof` 分流）。在 `system/init` 分支后加：

```ts
  if (msg.type === 'system' && msg.subtype === 'permission_denied') {
    const tool = msg.tool_name ?? 'unknown';
    const why =
      (typeof msg.decision_reason === 'string' && msg.decision_reason) ||
      (typeof msg.message === 'string' && msg.message) ||
      'permission denied';
    out.push({ type: 'notice', text: `工具 ${tool} 被自动拒绝：${why}` });
    return out;
  }
```

（既有 assistant/user 分支读取 `msg.message?.content` 处改为先判 `typeof msg.message === 'object'`。）

`src/card/run-state.ts`：`reduce` 的 switch 加：

```ts
    case 'notice': {
      return {
        ...state,
        blocks: [
          ...closeStreamingText(state.blocks),
          { kind: 'text', content: `_⛔ ${evt.text}_`, streaming: false },
        ],
        reasoning: { ...state.reasoning, active: false },
      };
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/unit/agent/claude/sdk-translate.test.ts tests/unit/card/run-state-notice.test.ts && pnpm typecheck`
Expected: PASS（translate 既有用例不受 `message` 放宽影响）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/claude/sdk-translate.ts src/card/run-state.ts tests/
git commit -m "feat(claude): surface classifier permission denials as card notices

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: 审批卡片模块（构建器 + Tracker）

**Files:**
- Create: `src/card/approval-card.ts`
- Test: `tests/unit/card/approval-card.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` 的 `permission_request` / `permission_resolved` 成员（Task 3）。
- Produces（Task 6 依赖，签名必须一致）:

```ts
export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'run_ended';
export interface ApprovalCardIo {
  send(card: object): Promise<{ messageId: string }>;
  update(messageId: string, card: object): Promise<void>;
}
export interface ApprovalCardOptions {
  timeoutMinutes: number;
  sign?: (action: string) => string;
}
export function renderApprovalCard(
  req: { id: string; toolName: string; input: unknown; title?: string; displayName?: string; description?: string },
  view: { kind: 'pending'; timeoutMinutes: number; sign?: (action: string) => string } | { kind: 'resolved'; outcome: ApprovalOutcome },
): object;
export class ApprovalCardTracker {
  constructor(io: ApprovalCardIo, opts: ApprovalCardOptions);
  onRequest(evt: Extract<AgentEvent, { type: 'permission_request' }>): Promise<void>;
  onResolved(evt: Extract<AgentEvent, { type: 'permission_resolved' }>): Promise<void>;
  sweep(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/card/approval-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ApprovalCardTracker,
  renderApprovalCard,
  type ApprovalCardIo,
} from '../../../src/card/approval-card.js';

const REQ = {
  id: 'tu-1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Claude wants to run rm -rf build',
  description: 'Claude will delete the build directory',
};

function fakeIo() {
  const sent: object[] = [];
  const updated: Array<{ messageId: string; card: object }> = [];
  let fail = false;
  const io: ApprovalCardIo = {
    send: async (card) => {
      if (fail) throw new Error('send failed');
      sent.push(card);
      return { messageId: `m-${sent.length}` };
    },
    update: async (messageId, card) => {
      updated.push({ messageId, card });
    },
  };
  return { io, sent, updated, setFail: (v: boolean) => (fail = v) };
}

describe('renderApprovalCard', () => {
  it('pending card carries title, tool, deadline note, and signed buttons', () => {
    const card = JSON.stringify(
      renderApprovalCard(REQ, { kind: 'pending', timeoutMinutes: 5, sign: (a) => `tok-${a}` }),
    );
    expect(card).toContain('Claude wants to run rm -rf build');
    expect(card).toContain('Bash');
    expect(card).toContain('5 分钟内未处理将自动拒绝');
    expect(card).toContain('"cmd":"perm.allow"');
    expect(card).toContain('"cmd":"perm.deny"');
    expect(card).toContain('tok-perm.allow');
    expect(card).toContain('tok-perm.deny');
    expect(card).toContain('"arg":"tu-1"');
    expect(card).toContain('__bridge_cb');
  });

  it('resolved cards show outcome and no buttons', () => {
    for (const [outcome, marker] of [
      ['allowed', '已放行'],
      ['denied', '已拒绝'],
      ['timeout', '超时自动拒绝'],
      ['run_ended', '运行已结束'],
    ] as const) {
      const card = JSON.stringify(renderApprovalCard(REQ, { kind: 'resolved', outcome }));
      expect(card).toContain(marker);
      expect(card).not.toContain('"tag":"button"');
    }
  });

  it('falls back to toolName when title is absent', () => {
    const card = JSON.stringify(
      renderApprovalCard({ id: 'x', toolName: 'WebFetch', input: {} }, { kind: 'pending', timeoutMinutes: 5 }),
    );
    expect(card).toContain('WebFetch');
  });
});

describe('ApprovalCardTracker', () => {
  it('sends on request, updates to outcome on resolve, forgets the entry', async () => {
    const { io, sent, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    expect(sent).toHaveLength(1);
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'allow', reason: 'user' });
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0]!.card)).toContain('已放行');
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'allow', reason: 'user' });
    expect(updated).toHaveLength(1); // second resolve is a no-op
  });

  it('maps reasons to outcomes (timeout, aborted)', async () => {
    const { io, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'deny', reason: 'timeout' });
    expect(JSON.stringify(updated[0]!.card)).toContain('超时自动拒绝');
  });

  it('sweep marks all unresolved cards as run_ended', async () => {
    const { io, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    await t.onRequest({ type: 'permission_request', ...REQ, id: 'tu-2' });
    await t.sweep();
    expect(updated).toHaveLength(2);
    for (const u of updated) expect(JSON.stringify(u.card)).toContain('运行已结束');
    await t.sweep();
    expect(updated).toHaveLength(2); // idempotent
  });

  it('swallows send failures (adapter timeout still governs the run)', async () => {
    const { io, setFail } = fakeIo();
    setFail(true);
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await expect(t.onRequest({ type: 'permission_request', ...REQ })).resolves.toBeUndefined();
    await expect(t.sweep()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/card/approval-card.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Implement**

Create `src/card/approval-card.ts`:

```ts
import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';

type PermissionRequest = Extract<AgentEvent, { type: 'permission_request' }>;
type PermissionResolved = Extract<AgentEvent, { type: 'permission_resolved' }>;

export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'run_ended';

export interface ApprovalCardIo {
  send(card: object): Promise<{ messageId: string }>;
  update(messageId: string, card: object): Promise<void>;
}

export interface ApprovalCardOptions {
  timeoutMinutes: number;
  sign?: (action: string) => string;
}

const INPUT_PREVIEW_MAX = 600;

const OUTCOME_NOTES: Record<ApprovalOutcome, string> = {
  allowed: '✅ 已放行',
  denied: '🚫 已拒绝',
  timeout: '⏱ 超时自动拒绝',
  run_ended: '⏹ 运行已结束，自动拒绝',
};

export function renderApprovalCard(
  req: {
    id: string;
    toolName: string;
    input: unknown;
    title?: string;
    displayName?: string;
    description?: string;
  },
  view:
    | { kind: 'pending'; timeoutMinutes: number; sign?: (action: string) => string }
    | { kind: 'resolved'; outcome: ApprovalOutcome },
): object {
  const heading = req.title ?? `Claude 请求执行：${req.displayName ?? req.toolName}`;
  const elements: object[] = [
    { tag: 'markdown', content: `**${heading}**` },
    { tag: 'markdown', content: `工具：\`${req.toolName}\`` },
  ];
  const preview = inputPreview(req.input);
  if (preview) {
    elements.push({ tag: 'markdown', content: `\`\`\`\n${preview}\n\`\`\`` });
  }
  if (req.description) {
    elements.push({ tag: 'markdown', content: req.description, text_size: 'notation' });
  }

  if (view.kind === 'pending') {
    elements.push({
      tag: 'markdown',
      content: `_${view.timeoutMinutes} 分钟内未处理将自动拒绝_`,
      text_size: 'notation',
    });
    elements.push({
      tag: 'column_set',
      columns: [
        { tag: 'column', elements: [approvalButton('放行', 'perm.allow', req.id, 'primary', view.sign)] },
        { tag: 'column', elements: [approvalButton('拒绝', 'perm.deny', req.id, 'danger', view.sign)] },
      ],
    });
  } else {
    elements.push({ tag: 'markdown', content: `**${OUTCOME_NOTES[view.outcome]}**` });
  }

  return {
    schema: '2.0',
    config: { summary: { content: heading } },
    body: { elements },
  };
}

function approvalButton(
  label: string,
  cmd: 'perm.allow' | 'perm.deny',
  permissionId: string,
  style: 'primary' | 'danger',
  sign?: (action: string) => string,
): object {
  const value: Record<string, unknown> = { cmd, arg: permissionId };
  if (sign) {
    value.__bridge_cb = true;
    value.bridge_token = sign(cmd);
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: style,
    behaviors: [{ type: 'callback', value }],
  };
}

function inputPreview(input: unknown): string {
  if (input === undefined || input === null) return '';
  const raw = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  return raw.length > INPUT_PREVIEW_MAX ? `${raw.slice(0, INPUT_PREVIEW_MAX)}…` : raw;
}

interface OpenEntry {
  messageId: string;
  req: PermissionRequest;
}

/**
 * Tracks one approval card per parked permission request. Purely reactive:
 * outcome updates are driven by permission_resolved events (the adapter's
 * settle() funnel is the single timing authority), plus a sweep() for
 * requests still open when the run's event stream ends (the force-resolve
 * on abort lands after the terminal event and never reaches consumers).
 */
export class ApprovalCardTracker {
  private readonly open = new Map<string, OpenEntry>();

  constructor(
    private readonly io: ApprovalCardIo,
    private readonly opts: ApprovalCardOptions,
  ) {}

  async onRequest(evt: PermissionRequest): Promise<void> {
    try {
      const { messageId } = await this.io.send(
        renderApprovalCard(evt, {
          kind: 'pending',
          timeoutMinutes: this.opts.timeoutMinutes,
          ...(this.opts.sign ? { sign: this.opts.sign } : {}),
        }),
      );
      this.open.set(evt.id, { messageId, req: evt });
    } catch (err) {
      // The adapter's own timeout still resolves the park; losing the card
      // only loses the approve path, never hangs the run.
      log.fail('approval-card', err, { step: 'send', id: evt.id });
    }
  }

  async onResolved(evt: PermissionResolved): Promise<void> {
    const entry = this.open.get(evt.id);
    if (!entry) return;
    this.open.delete(evt.id);
    const outcome: ApprovalOutcome =
      evt.reason === 'timeout'
        ? 'timeout'
        : evt.reason === 'aborted'
          ? 'run_ended'
          : evt.decision === 'allow'
            ? 'allowed'
            : 'denied';
    await this.updateSafe(entry, outcome);
  }

  async sweep(): Promise<void> {
    const entries = [...this.open.values()];
    this.open.clear();
    for (const entry of entries) {
      await this.updateSafe(entry, 'run_ended');
    }
  }

  private async updateSafe(entry: OpenEntry, outcome: ApprovalOutcome): Promise<void> {
    try {
      await this.io.update(entry.messageId, renderApprovalCard(entry.req, { kind: 'resolved', outcome }));
    } catch (err) {
      log.fail('approval-card', err, { step: 'update', id: entry.req.id, outcome });
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/unit/card/approval-card.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/card/approval-card.ts tests/unit/card/approval-card.test.ts
git commit -m "feat(card): approval card renderer and tracker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: channel 接线 + `/perm` 处理器 + 生产开启

**Files:**
- Modify: `src/bot/channel.ts`（`processAgentStream` 签名与循环、`runAgentBatch`）
- Modify: `src/commands/index.ts`（注册 `/perm`）
- Modify: `src/cli/commands/start.ts:437`（`createRuntimeAgent`）
- Test: `tests/unit/commands/perm-handler.test.ts`（新建）；全量回归

**Interfaces:**
- Consumes: `ApprovalCardTracker`/`renderApprovalCard`（Task 5）、`permission_request`/`permission_resolved` 事件（Task 3）、`profileConfig.claude`（Task 2）。
- Produces: `processAgentStream` 新可选形参 `approvals?: { onRequest(evt): Promise<void>; onResolved(evt): Promise<void>; sweep(): Promise<void> }`（`ApprovalCardTracker` 结构兼容）。

- [ ] **Step 1: Write the failing test（/perm 处理器）**

Create `tests/unit/commands/perm-handler.test.ts`（构造最小 `CommandContext`；对齐同目录既有 command 测试的 fake 构造方式，若无先例则按下述最小形状直造并 `as unknown as CommandContext`）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { runCommandHandler, type CommandContext } from '../../../src/commands/index.js';

function makeCtx(overrides: { fromCardAction: boolean; respond?: ReturnType<typeof vi.fn> }) {
  const respond = overrides.respond ?? vi.fn();
  const ctx = {
    channel: { send: vi.fn() },
    msg: { chatId: 'c1', messageId: 'm1', senderId: 'u1', content: '' },
    scope: 'c1',
    chatMode: 'p2p',
    sessions: {},
    workspaces: {},
    agent: {},
    activeRuns: { get: () => ({ run: { respondPermission: respond }, interrupted: false }) },
    controls: { profileConfig: {}, cfg: {} },
    fromCardAction: overrides.fromCardAction,
  } as unknown as CommandContext;
  return { ctx, respond };
}

describe('/perm handler', () => {
  it('routes card-click allow to respondPermission', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: true });
    const ok = await runCommandHandler('perm', 'allow tu-1', ctx);
    expect(ok).toBe(true);
    expect(respond).toHaveBeenCalledWith('tu-1', 'allow');
  });

  it('routes deny', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: true });
    await runCommandHandler('perm', 'deny tu-2', ctx);
    expect(respond).toHaveBeenCalledWith('tu-2', 'deny');
  });

  it('rejects text-command invocation (no card action)', async () => {
    const { ctx, respond } = makeCtx({ fromCardAction: false });
    await runCommandHandler('perm', 'allow tu-1', ctx);
    expect(respond).not.toHaveBeenCalled();
  });

  it('is a silent no-op without an active run or with bad args', async () => {
    const respond = vi.fn();
    const { ctx } = makeCtx({ fromCardAction: true, respond });
    (ctx as { activeRuns: unknown }).activeRuns = { get: () => undefined };
    await expect(runCommandHandler('perm', 'allow tu-1', ctx)).resolves.toBe(true);
    const { ctx: ctx2, respond: r2 } = makeCtx({ fromCardAction: true });
    await runCommandHandler('perm', 'frobnicate tu-1', ctx2);
    expect(r2).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/commands/perm-handler.test.ts`
Expected: FAIL（`runCommandHandler('perm', …)` 返回 false，未注册）。

- [ ] **Step 3: Implement `/perm`（commands/index.ts）**

注册表加 `'/perm': handlePerm,`（**不要**加入 `ADMIN_COMMANDS`——点击者已过 access 检查且 token 绑定 operator）。处理器：

```ts
/**
 * Approval-card button callback. Card-click ONLY: a typed `/perm allow <id>`
 * would bypass the bridge_token signature the dispatcher verifies for card
 * clicks, so text invocations are rejected outright. No card update here —
 * the adapter's permission_resolved event drives the card to its outcome.
 */
async function handlePerm(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.fromCardAction) {
    await reply(ctx, '❌ 该操作仅支持通过审批卡片按钮进行。');
    return;
  }
  const [decision, id] = args.trim().split(/\s+/);
  if ((decision !== 'allow' && decision !== 'deny') || !id) {
    log.warn('perm', 'bad-args', { args: args.slice(0, 80) });
    return;
  }
  const active = ctx.activeRuns.get(ctx.scope);
  if (!active) {
    log.info('perm', 'no-active-run', { scope: ctx.scope });
    return;
  }
  active.run.respondPermission?.(id, decision);
  log.info('perm', 'responded', { scope: ctx.scope, id, decision });
}
```

（`reply`/`log` 均为该文件既有引用。）

- [ ] **Step 4: channel 接线（channel.ts）**

`processAgentStream` 签名追加第 7 形参：

```ts
  approvals?: {
    onRequest(evt: Extract<AgentEvent, { type: 'permission_request' }>): Promise<void>;
    onResolved(evt: Extract<AgentEvent, { type: 'permission_resolved' }>): Promise<void>;
    sweep(): Promise<void>;
  },
```

循环内两处修改。其一：看门狗记账的 if/else 链（`tool_use`/`tool_result` 分支处）追加——审批泊停期间 claude 静默，必须暂停空闲看门狗，且 permission id 就是将来 `tool_use`/`tool_result` 的 id，同键复用：

```ts
      } else if (evt.type === 'permission_request') {
        inFlightTools.add(evt.id);
        log.info('agent', 'permission-parked', { id: evt.id, tool: evt.toolName });
      }
```

其二：`system`/`usage` 特判之后追加（不进 `reduce`/流式卡片）：

```ts
      if (evt.type === 'permission_request') {
        if (approvals) await approvals.onRequest(evt);
        continue;
      }
      if (evt.type === 'permission_resolved') {
        if (approvals) await approvals.onResolved(evt);
        continue;
      }
```

循环结束后（`finally` 的 `clearTimeout` 之后、终态归一化之前或之后均可，选一处执行一次）：

```ts
  if (approvals) await approvals.sweep();
```

`runAgentBatch`：在 `cardRenderOptions` 定义之后构建 tracker（所有 replyMode 共用；无 `callbackAuth` 时按钮不带签名、dispatcher 会拒绝——保持与 stop 按钮相同的降级行为）：

```ts
  const approvalTimeoutMinutes = controls.profileConfig.claude?.approvalTimeoutMinutes ?? 5;
  const approvals = new ApprovalCardTracker(
    {
      send: async (card) => {
        const { messageId } = await sendManagedCard(channel, chatId, card, sendOpts);
        return { messageId };
      },
      update: (messageId, card) => updateManagedCard(channel, messageId, card),
    },
    {
      timeoutMinutes: approvalTimeoutMinutes,
      ...(cardRenderOptions.signCallback ? { sign: cardRenderOptions.signCallback } : {}),
    },
  );
```

三处 `processAgentStream(...)` 调用（card/markdown/text 模式）末尾均追加实参 `approvals`。imports 补 `ApprovalCardTracker`（`../card/approval-card`）、`sendManagedCard, updateManagedCard`（`../card/managed`）。

- [ ] **Step 5: 生产开启（start.ts）**

`createRuntimeAgent` 的 claude 分支改为：

```ts
  const claude = profileConfig.claude;
  return new ClaudeSdkAdapter({
    larkChannel,
    approvalEnabled: true,
    ...(claude?.env ? { env: claude.env } : {}),
    ...(claude?.approvalTimeoutMinutes
      ? { permissionTimeoutMs: claude.approvalTimeoutMinutes * 60_000 }
      : {}),
  });
```

- [ ] **Step 6: 全量回归**

Run: `pnpm vitest run tests/unit/commands/perm-handler.test.ts && pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿。特别注意既有 `start-runtime-lock-conflict` 与 `adapter-system-prompt-wiring` 测试不受 `approvalEnabled: true` 影响（前者 mock 类、后者未断言该选项）；若有测试因新构造参数失败，仅更新其构造期望，不得削弱断言。

- [ ] **Step 7: Commit**

```bash
git add src/bot/channel.ts src/commands/index.ts src/cli/commands/start.ts tests/
git commit -m "feat(bot): wire approval cards into the run loop and enable approval

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: 真机冒烟 checklist（文档交付，用户执行）

**Files:**
- Create: `docs/superpowers/verification/2026-07-07-phase1b-smoke.md`

本环境无飞书客户端与已绑定的 app，冒烟由用户在真机执行；本任务交付一份可照做的 checklist。

- [ ] **Step 1: Write the checklist**

文件内容（完整写入，不留空节）：

```markdown
# Phase 1b 真机冒烟 checklist

前置：`pnpm build` 后以本分支启动 bridge（`node bin/lark-channel-bridge.mjs run` 或已装的全局命令指向本仓库 dist）；确认 `claude --version` ≥ 支持 `--permission-mode auto`（`claude -p "hi" --permission-mode auto` 不报 unknown mode 即可；不支持则在 profile 配 `permissions.claude.permissionMode: "bypassPermissions"` 回退并中止本 checklist，回报版本号）。

## A. 流式对等（full → auto，默认配置）
- [ ] 发一条普通消息（如"介绍一下这个项目"），流式卡片正常增量更新、正常收尾（无 stall、无重复 final 消息）。
- [ ] 发一条会触发工具的消息（如"列出当前目录文件"），工具调用在卡片上可见，Read/LS 类操作不弹审批卡。
- [ ] 观察是否出现"⛔ 工具 X 被自动拒绝"注记（auto 分类器拒绝路径）；若出现，确认 claude 有后续应对而非静默中断。

## B. 审批全流程（read-only 或 workspace 访问模式）
配置 `permissions.defaultAccess: "workspace"` 重启，或临时把 `claude.approvalTimeoutMinutes` 设为 1 便于测超时。
- [ ] 让 claude 执行一个写操作（如"创建文件 test.txt 内容 hello"）：弹出独立审批卡片，标题为 claude 生成的提示句，含放行/拒绝按钮与超时提示。
- [ ] 点击【放行】：卡片原地变为"✅ 已放行"，run 继续并完成写入。
- [ ] 再触发一次，点击【拒绝】：卡片变"🚫 已拒绝"，claude 收到拒绝并调整。
- [ ] 再触发一次，不操作等超时：卡片变"⏱ 超时自动拒绝"，run 安全收尾。
- [ ] 审批等待期间（约 1 分钟）确认空闲看门狗未误杀 run。
- [ ] 触发审批后立即 /stop：卡片变"⏹ 运行已结束，自动拒绝"。

## C. 安全路径
- [ ] 同一审批按钮点击两次：第二次无效果（nonce 一次性）。
- [ ] （有条件时）另一账号点击审批按钮：被拒绝（token 绑定发起人）。
- [ ] 文本输入 `/perm allow xxx`：收到"仅支持通过审批卡片按钮"的拒绝回复。

结果回报：全部通过 → Phase 1b 可合并；任何一条失败 → 记录现象与 bridge 日志（`~/.lark-channel/logs/`）回报。
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/verification/2026-07-07-phase1b-smoke.md
git commit -m "docs: phase 1b real-machine smoke checklist

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Phase 2 入场门实验（mid-turn steering）

**Files:**
- Create: `docs/superpowers/specs/2026-07-07-phase2-steering-gate-findings.md`
- 实验脚本写在 job 临时目录（如 `$CLAUDE_JOB_DIR/tmp/steering-gate.mjs`），**不提交**。

- [ ] **Step 1: Write the experiment script**（临时目录）

```js
// steering-gate.mjs — verify whether SDK streaming input can steer mid-turn.
// Run: node steering-gate.mjs   (requires a logged-in local claude)
import { query } from '@anthropic-ai/claude-agent-sdk';

const msg = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

async function* input() {
  yield msg('Count from 1 to 30 slowly, one number per line, thinking carefully between each.');
  await new Promise((r) => setTimeout(r, 8000)); // mid-turn
  console.error('>>> injecting steering message now');
  yield msg('STOP counting. Instead say only the word PIVOT and end your turn.');
}

const q = query({
  prompt: input(),
  options: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, cwd: process.cwd() },
});
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) if (b.type === 'text') process.stdout.write(b.text);
  }
  if (m.type === 'result') {
    console.error(`\n>>> result: num_turns=${m.num_turns}`);
    break;
  }
}
```

- [ ] **Step 2: Run it**（需本机 claude 已登录；不可用则记录阻塞原因，交用户执行）

Run: `cd <worktree> && node $CLAUDE_JOB_DIR/tmp/steering-gate.mjs`
观察判据：注入的第二条消息是**当轮被吸收**（输出中途转向 PIVOT、`num_turns` 仍为 1 轮内）还是**排队为独立第二轮**（数完 30 才 PIVOT）。同时留意 `SDKUserMessage.priority`（`'now' | 'next' | 'later'`）字段是否影响行为——若基础实验显示排队，补测 `priority: 'now'`。

- [ ] **Step 3: Write the findings doc**

`docs/superpowers/specs/2026-07-07-phase2-steering-gate-findings.md` 记录：实验命令、SDK/claude 版本、原始观察（截断的输出样本）、结论三选一——(a) 支持真 mid-turn steering → Phase 2 按 spec §6.2 设计；(b) 仅轮间排队 → Phase 2 退回排队语义、按 spec §6.1 降级；(c) 环境无法运行（无登录）→ 附用户自跑指引。**不得只写结论不附观察证据。**

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-07-phase2-steering-gate-findings.md
git commit -m "docs: phase 2 mid-turn steering gate findings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：** §2 auto 模式（Task 1 + Task 7 入场核查步骤）；§3 `permission_resolved` + 兜底清扫（Task 3 + Task 6 sweep）；§4 卡片/签名/回传/终态（Task 5 + Task 6）；§5 permission_denied 注记（Task 4）；§6 配置（Task 2 + Task 6 Step 5）；§7 验证（各任务测试 + Task 7 checklist；`SAFE_READONLY_TOOLS` 断言并入 Task 3）；§8 入场门实验（Task 8）；§9 风险已在对应任务的实现注释与降级行为中体现。无缺口。

**Placeholder scan：** 无 TBD/TODO；Task 2 对 `normalizeProfileConfig` 入口名做了"实现前核对"的显式指令而非假定，属事实核查步骤，非占位。

**Type consistency：** `permission_resolved` 形状在 Task 3（types/adapter）、Task 5（tracker consume）、Task 6（approvals 钩子）一致；`ApprovalCardIo`/`ApprovalCardTracker` 签名在 Task 5 定义与 Task 6 使用一致（结构兼容 `approvals` 形参）；`perm.allow`/`perm.deny` 的 cmd 字符串在 Task 5 按钮、dispatcher 既有 `verifyBridgeToken(deps,payload,scope,cmd)`（action=完整 cmd 串）、Task 6 签名 `sign('perm.allow')` 三处一致；`claude.approvalTimeoutMinutes` 在 Task 2 定义与 Task 6 两处消费一致。
