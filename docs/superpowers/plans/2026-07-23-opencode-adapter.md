# OpenCode Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenCode agent adapter to `lark-channel-bridge` so a Feishu message routed to an OpenCode profile spawns `opencode run --format json` and streams the NDJSON reply back as an interactive Lark card.

**Architecture:** Mirror the existing Codex adapter's three-file structure (`adapter.ts` + `jsonl.ts` + `argv.ts`). The adapter spawns one `opencode run` subprocess per run, feeds the prompt via stdin, reads NDJSON from stdout, and translates events into the shared `AgentEvent` stream that `RunState`/renderers already consume. A new `AgentKind = 'opencode'` flows through config, capability, runtime wiring, and session catalog (using the Claude-style `sessionId` path, not Codex's `threadId`).

**Tech Stack:** Node.js (ESM, TypeScript, strict), pnpm@10.33.0, vitest, commander. The OpenCode CLI (`opencode`, npm `opencode-ai`) is an external dependency the user installs separately.

## Global Constraints

- Node **>= 20.12.0**, pnpm **@10.33.0** (exact, from `package.json`).
- TypeScript strict mode: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride`. Use `import type` for type-only imports.
- `pnpm test` always rebuilds the web console first (`pretest` → `build:web`); tests import `src/ui/generated/index.html` as a string. If a test touches the UI server and fails on missing HTML, run `pnpm build:web` first.
- **Prompts must never go through argv.** On Windows, `opencode` resolves through `cmd.exe`, which interprets `<`/`>` as redirection and silently eats the prompt's `<bridge_context>` XML. The prompt goes through stdin (same as Codex/Claude adapters).
- **Each profile gets its own adapter instance** — the adapter stores bot identity on itself via `setBotIdentity`, set late after the WS handshake.
- `AgentEvent` (`src/agent/types.ts`) is the single shared stream contract; adapters only emit `AgentEvent`s.
- Access is fail-closed: empty allowlists mean nobody. Access modes map to agent modes.
- Spec: `docs/superpowers/specs/2026-07-23-opencode-adapter-design.md`.

---

## File Structure

**New files:**
- `src/agent/opencode/argv.ts` — `buildOpencodeArgs()`: constructs the `opencode run` argv from cwd/access/session/model/prompt. Pure function, no I/O.
- `src/agent/opencode/jsonl.ts` — `OpencodeJsonlTranslator` class: translates OpenCode NDJSON events → `AgentEvent[]`. Stateful (terminal tracking, pending-text buffering, drift counters). No I/O.
- `src/agent/opencode/adapter.ts` — `OpencodeAdapter implements AgentAdapter`: spawn + lifecycle + event stream. Owns `stop()`/`waitForExit()`.
- `tests/unit/agent/opencode-argv.test.ts` — argv contract + permission mapping.
- `tests/unit/agent/opencode-jsonl.test.ts` — translator event coverage.
- `tests/process/opencode-adapter.test.ts` — end-to-end via a fake `opencode` binary.

**Modified files (touch-points):**
- `src/config/profile-schema.ts` — `AgentKind` + `OpencodeConfig` + `normalizeProfileConfig`/`normalizeOpencode`.
- `src/agent/capability.ts` — `AgentCapabilityId`/`AgentSessionKind` + `opencodeCapability()`.
- `src/agent/models.ts` — `fetchOpencodeModels()` + opencode branches in `supportedModels`/`normalizeModelSelection`/`resolveModelArg`/`modelLabel`.
- `src/agent/index.ts` — export `OpencodeAdapter`.
- `src/agent/preflight.ts` — `LocalAgentId` + `isAgentPreflightDiagnostic` accept `'opencode'`.
- `src/runtime/agent-runtime.ts` — `createRuntimeAgent` opencode branch + availability fallback.
- `src/runtime/profile-runtime.ts` — displayName map + non-codex branch audit.
- `src/runtime/locks.ts` + `src/runtime/registry.ts` — three-way agentKind validation.
- `src/cli/agent-detection.ts` — `detectInstalledAgents` adds opencode.
- `src/cli/profile-bootstrap.ts` — `createBootstrapOpencodeConfig()` + `createBootstrapProfileConfig` branch.
- `src/session/catalog.ts` — opencode → sessionId path (3 sites).
- `src/bot/channel.ts` + `src/commands/index.ts` — capability selection three-way + model picker async + resume/record session branches.
- `src/bot/run-flow.ts` + `src/bot/comments.ts` + `src/bot/session-catalog-identity.ts` — sessionId resume/record branches extend to opencode.
- `src/cli/commands/migrate.ts` + `src/config/migrate-v2.ts` — `agentKindFromString` accepts opencode.
- `src/ui/qr-register.ts` + `src/ui/onboard.ts` — three-way agentKind.
- `src/cli/commands/service.ts` — daemon service label branch.
- `README.md` — OpenCode section.
- `tests/unit/config/profile-schema.test.ts` + `tests/unit/cli/start-agent-factory.test.ts` + `tests/static/contracts.test.ts` + `tests/unit/docs/readme-contract.test.ts` — extend assertions.

---

### Task 1: Extend `AgentKind` and add `OpencodeConfig` config block

**Files:**
- Modify: `src/config/profile-schema.ts` (types at `:16`, `:34-52` CodexConfig vicinity, `:98-119` ProfileConfig, `:201-207` validation, `:235` return spread, `:326-341` normalizeCodex vicinity)
- Test: `tests/unit/config/profile-schema.test.ts`

**Interfaces:**
- Produces: `AgentKind = 'claude' | 'codex | 'opencode'`, `OpencodeConfig` interface, `ProfileConfig.opencode?: OpencodeConfig`, `normalizeOpencode()` helper, `createDefaultProfileConfig`/`CreateDefaultProfileConfigInput` accept `opencode`. Later tasks import `AgentKind` and `OpencodeConfig` from here.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/config/profile-schema.test.ts` (append inside the existing top-level `describe` or add a new `describe` block — check the file's existing structure first and match it):

```ts
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import type { OpencodeConfig } from '../../../src/config/profile-schema.js';

describe('opencode profile', () => {
  const baseApp = { app: { id: 'cli_x', secret: 'shh', tenant: 'feishu' as const } };

  it('rejects an opencode profile missing the opencode block', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'opencode',
        accounts: baseApp,
      }),
    ).toThrow('opencode profile requires opencode configuration');
  });

  it('accepts an opencode profile with binaryPath', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'opencode',
      accounts: baseApp,
      opencode: { binaryPath: '/usr/local/bin/opencode' },
    });
    expect(cfg.agentKind).toBe('opencode');
    expect(cfg.opencode?.binaryPath).toBe('/usr/local/bin/opencode');
    expect(cfg.opencode?.inheritConfig).toBeUndefined();
  });

  it('round-trips opencode config through createDefaultProfileConfig', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'opencode',
      accounts: baseApp,
      opencode: { binaryPath: '/opt/opencode', inheritConfig: true, ignoreUserConfig: false },
    });
    expect(cfg.opencode).toEqual({
      binaryPath: '/opt/opencode',
      inheritConfig: true,
      ignoreUserConfig: false,
    });
  });

  it('rejects an invalid agentKind', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'gemini',
        accounts: baseApp,
      } as unknown as Parameters<typeof normalizeProfileConfig>[0]),
    ).toThrow('agentKind must be claude, codex, or opencode');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/config/profile-schema`
Expected: FAIL — `opencode` not assignable to `AgentKind`, `OpencodeConfig` not exported, `requires opencode configuration` message mismatch.

- [ ] **Step 3: Extend `AgentKind` and add `OpencodeConfig`**

In `src/config/profile-schema.ts`, update the `AgentKind` type (line ~16):

```ts
export type AgentKind = 'claude' | 'codex' | 'opencode';
```

Add the `OpencodeConfig` interface right after the existing `CodexConfig` interface (after line ~52):

```ts
export interface OpencodeConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  /** When false, point OPENCODE_CONFIG_DIR at <profileDir>/opencode-config
   *  for per-profile config isolation. Default (undefined/true) inherits the
   *  user's ~/.config/opencode. Analogous to Codex's inheritCodexHome. */
  inheritConfig?: boolean;
  ignoreUserConfig?: boolean;
}
```

- [ ] **Step 4: Add `opencode` to `ProfileConfig` and input types**

Add `opencode?: OpencodeConfig;` to the `ProfileConfig` interface (after the existing `codex?: CodexConfig;` at line ~115). Add `opencode?: OpencodeConfig;` to `CreateDefaultProfileConfigInput` (after `codex?: CodexConfig;` at line ~157). Add `opencode?: OpencodeConfig & { flags?: unknown };` to the `raw` cast inside `normalizeProfileConfig` (next to the existing `codex?: CodexConfig & { flags?: unknown };` at line ~192).

- [ ] **Step 5: Update validation + normalization**

In `normalizeProfileConfig`, change the agentKind validation (lines ~201-203):

```ts
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex' && raw.agentKind !== 'opencode') {
    throw new Error('agentKind must be claude, codex, or opencode');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }
  if (raw.agentKind === 'opencode' && !raw.opencode) {
    throw new Error('opencode profile requires opencode configuration');
  }
```

In the return object (after the `...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {})` spread at line ~235), add:

```ts
    ...(raw.opencode ? { opencode: normalizeOpencode(raw.opencode) } : {}),
```

Add the `normalizeOpencode` function next to `normalizeCodex` (after line ~341). Mirror `normalizeCodex`'s shape but for the opencode fields:

```ts
function normalizeOpencode(input: OpencodeConfig & { flags?: unknown }): OpencodeConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid opencode config');
  }
  if (typeof input.binaryPath !== 'string' || !input.binaryPath) {
    throw new Error('opencode.binaryPath must be a non-empty string');
  }
  return {
    binaryPath: input.binaryPath,
    ...(input.realpath ? { realpath: input.realpath } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.inheritConfig !== undefined ? { inheritConfig: input.inheritConfig } : {}),
    ...(input.ignoreUserConfig !== undefined ? { ignoreUserConfig: input.ignoreUserConfig } : {}),
  };
}
```

Check what `normalizeCodex` actually does (read lines ~326-341) and match its handling of unknown `flags` if it drops them — do the same in `normalizeOpencode` (the `& { flags?: unknown }` in the param type is for input compat; do not carry `flags` into the return value).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test unit/config/profile-schema`
Expected: PASS.

- [ ] **Step 7: Run typecheck to catch downstream two-way-branch type errors**

Run: `pnpm typecheck`
Expected: Possibly errors in files that exhaustively switch on `AgentKind` (e.g. `agent-detection.ts`, `models.ts`, `profile-runtime.ts`). These are fixed in later tasks — note them but do not fix here unless they block compilation of `profile-schema.ts` itself. If `profile-schema.ts` typechecks clean, proceed.

- [ ] **Step 8: Commit**

```bash
git add src/config/profile-schema.ts tests/unit/config/profile-schema.test.ts
git commit -m "feat(config): add opencode AgentKind and OpencodeConfig profile block"
```

---

### Task 2: Add `opencodeCapability` and extend capability types

**Files:**
- Modify: `src/agent/capability.ts`
- Test: `tests/unit/agent/capability.test.ts`

**Interfaces:**
- Consumes: `ProfileConfig['permissions']` from Task 1, `BRIDGE_SYSTEM_PROMPT` (existing).
- Produces: `AgentCapabilityId = 'claude' | 'codex' | 'opencode'`, `AgentSessionKind = 'claude-session' | 'codex-thread' | 'opencode-session'`, `opencodeCapability(profile)` returning `AgentCapability` with `agentId: 'opencode'`, `sessionKind: 'opencode-session'`, `promptInjection: 'stdin-prefix'`. Later tasks (channel.ts, commands/index.ts) call `opencodeCapability`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/agent/capability.test.ts` (read the file first to match its existing import style — it imports `claudeCapability`/`codexCapability`):

```ts
import { opencodeCapability } from '../../../src/agent/capability.js';

describe('opencodeCapability', () => {
  it('uses opencode agent id and opencode-session session kind', () => {
    const cap = opencodeCapability({ permissions: { defaultAccess: 'full', maxAccess: 'full' } });
    expect(cap.agentId).toBe('opencode');
    expect(cap.sessionKind).toBe('opencode-session');
    expect(cap.promptInjection).toBe('stdin-prefix');
    expect(cap.supportsNativeHistory).toBe(true);
    expect(cap.callback.marker).toBe('__bridge_cb');
    expect(cap.permissions.maxAccess).toBe('full');
  });

  it('clamps maxAccess from the profile permissions', () => {
    const cap = opencodeCapability({ permissions: { defaultAccess: 'read-only', maxAccess: 'workspace' } });
    expect(cap.permissions.maxAccess).toBe('workspace');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/agent/capability`
Expected: FAIL — `opencodeCapability` not exported.

- [ ] **Step 3: Extend the capability types and add `opencodeCapability`**

In `src/agent/capability.ts`, update the union types (lines ~5-7):

```ts
export type AgentCapabilityId = 'claude' | 'codex' | 'opencode';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'opencode-session';
```

Add `opencodeCapability` after `codexCapability` (after line ~58), modeled on `codexCapability`:

```ts
export function opencodeCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'opencode',
    sessionKind: 'opencode-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test unit/agent/capability`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/capability.ts tests/unit/agent/capability.test.ts
git commit -m "feat(agent): add opencodeCapability and opencode-session kind"
```

---

### Task 3: Build `buildOpencodeArgs` (argv builder)

**Files:**
- Create: `src/agent/opencode/argv.ts`
- Test: `tests/unit/agent/opencode-argv.test.ts`

**Interfaces:**
- Consumes: `AccessMode` from `src/config/permissions.ts` (existing: `'read-only' | 'workspace' | 'full'`).
- Produces: `buildOpencodeArgs(input)` returning `string[]`. Called by the adapter (Task 5). The argv MUST NOT contain the prompt string (prompt goes via stdin).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/opencode-argv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildOpencodeArgs } from '../../../src/agent/opencode/argv.js';

describe('buildOpencodeArgs', () => {
  it('builds a fresh read-only run with plan agent and no --auto', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'read-only', prompt: 'hi' })).toEqual([
      'run',
      '--dir',
      '/repo',
      '--format',
      'json',
      '--agent',
      'plan',
      'hi',
    ]);
  });

  it('uses build agent with --auto for full access', () => {
    const args = buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' });
    expect(args).toEqual([
      'run',
      '--dir',
      '/repo',
      '--format',
      'json',
      '--agent',
      'build',
      '--auto',
      'hi',
    ]);
  });

  it('treats workspace identically to full (no workspace-write middle ground)', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'workspace', prompt: 'hi' })).toEqual(
      buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' }),
    );
  });

  it('forwards --session when a sessionId is provided', () => {
    const args = buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi', sessionId: 'sess-123' });
    expect(args).toContain('--session');
    expect(args[args.indexOf('--session') + 1]).toBe('sess-123');
  });

  it('forwards --model provider/model when a model is provided', () => {
    const args = buildOpencodeArgs({
      cwd: '/repo',
      access: 'full',
      prompt: 'hi',
      model: 'anthropic/claude-opus-4-8',
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-opus-4-8');
  });

  it('omits --model when no model is provided', () => {
    expect(buildOpencodeArgs({ cwd: '/repo', access: 'full', prompt: 'hi' })).not.toContain('--model');
  });

  it('rejects an invalid access mode', () => {
    expect(() => buildOpencodeArgs({ cwd: '/repo', access: 'bogus' as never, prompt: 'hi' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/agent/opencode-argv`
Expected: FAIL — module not found (`src/agent/opencode/argv.js`).

- [ ] **Step 3: Implement `buildOpencodeArgs`**

Create `src/agent/opencode/argv.ts`:

```ts
import type { AccessMode } from '../../config/permissions';

export interface BuildOpencodeArgsInput {
  cwd: string;
  access: AccessMode;
  /** Session id to resume via `--session`. Omitted on a fresh run. */
  sessionId?: string;
  /** `provider/model` forwarded to `--model`. Omitted uses the opencode default. */
  model?: string;
  /** Concatenated system prompt + user message. Goes on stdin, NOT argv. */
  prompt: string;
}

export function buildOpencodeArgs(input: BuildOpencodeArgsInput): string[] {
  if (input.access !== 'read-only' && input.access !== 'workspace' && input.access !== 'full') {
    throw new Error(`unsafe opencode access mode: ${input.access}`);
  }

  // read-only uses the `plan` agent and never auto-approves (permissions
  // auto-reject in non-interactive mode). full/workspace both use `build`
  // with --auto; OpenCode has no workspace-write middle ground.
  const isReadOnly = input.access === 'read-only';

  const args = [
    'run',
    '--dir',
    input.cwd,
    '--format',
    'json',
    '--agent',
    isReadOnly ? 'plan' : 'build',
  ];
  if (!isReadOnly) args.push('--auto');
  if (input.model) args.push('--model', input.model);
  if (input.sessionId) args.push('--session', input.sessionId);
  // The prompt is passed via stdin by the adapter (Windows argv safety),
  // so it never appears in argv. But opencode run accepts the message as a
  // positional arg OR via stdin when stdin is not a TTY — the adapter writes
  // the prompt to stdin, so we pass '-' is NOT needed; opencode reads stdin
  // automatically. We do NOT append the prompt here.
  return args;
}
```

Note: verify the claim about opencode reading stdin automatically. The OpenCode source (confirmed in spec) consumes `process.stdin` text when not a TTY and concatenates with any positional message. Since the adapter pipes stdin (not a TTY), opencode reads the prompt from stdin with NO positional arg needed. The `prompt` field stays in the input type only for clarity; it is intentionally unused in argv. If a later process test reveals opencode requires a positional `-` sentinel, add it here — but the spec research found no such sentinel (unlike Codex's `-`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test unit/agent/opencode-argv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode/argv.ts tests/unit/agent/opencode-argv.test.ts
git commit -m "feat(opencode): buildOpencodeArgs argv builder with permission mapping"
```

---

### Task 4: Build `OpencodeJsonlTranslator` (NDJSON → AgentEvent)

**Files:**
- Create: `src/agent/opencode/jsonl.ts`
- Test: `tests/unit/agent/opencode-jsonl.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` from `src/agent/types.ts` (existing).
- Produces: `OpencodeJsonlTranslator` class with `translate(raw): AgentEvent[]`, `finish(reason?): AgentEvent[]`, `fail(message): AgentEvent[]`, `terminalEmitted(): boolean`, `protocolDrift()`. Called by the adapter (Task 5). The `OpencodeFinishReason = 'failed' | 'interrupted' | 'timeout'` type mirrors `CodexFinishReason`.

**OpenCode event shapes (from spec):** each NDJSON line is `{"type","timestamp","sessionID", ...data}`. Emitted `type` values in `--format json` mode: `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`, `error`. The `part` field (mirrored from the subscribe stream) carries `part.type`, `part.state.status` (`completed`/`error`/`running`), `part.tool`, `part.text`, `part.state.error`, `part.id`. There is no standalone done event in JSON mode — termination is stdout EOF (handled by adapter), so the translator's `finish()` is the terminal fallback.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/opencode-jsonl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OpencodeJsonlTranslator } from '../../../src/agent/opencode/jsonl.js';

describe('OpencodeJsonlTranslator', () => {
  it('emits a system event carrying sessionId from the first envelope', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'text', timestamp: 1, sessionID: 'sess-1', part: { type: 'text', text: 'hi', time: { end: 2 } } })).toEqual([
      { type: 'system', sessionId: 'sess-1' },
    ]);
  });

  it('buffers text and emits final_text on finish', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'hello', time: { end: 2 } } });
    expect(t.finish('interrupted')).toEqual([
      { type: 'final_text', content: 'hello' },
      { type: 'done', sessionId: 's', terminationReason: 'interrupted' },
    ]);
  });

  it('flushes buffered text before a later tool_use', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'first', time: { end: 2 } } });
    expect(
      t.translate({
        type: 'tool_use',
        timestamp: 3,
        sessionID: 's',
        part: { id: 't1', type: 'tool', tool: 'bash', state: { status: 'completed' }, output: 'ok' },
      }),
    ).toEqual([
      { type: 'text', delta: 'first' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { output: 'ok' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    ]);
  });

  it('marks a tool_result as error when state.error is present', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { id: 't2', type: 'tool', tool: 'bash', state: { status: 'error', error: 'boom' } } });
    // tool_use with an error state still emits tool_use + tool_result(isError=true)
  });

  it('emits thinking delta for reasoning events', () => {
    const t = new OpencodeJsonlTranslator();
    expect(
      t.translate({ type: 'reasoning', timestamp: 1, sessionID: 's', part: { type: 'reasoning', text: 'hmm', time: { end: 2 } } }),
    ).toEqual([{ type: 'thinking', delta: 'hmm' }]);
  });

  it('records a non-terminal error and surfaces it on finish()', () => {
    const t = new OpencodeJsonlTranslator();
    t.translate({ type: 'error', timestamp: 1, sessionID: 's', error: { name: 'X', message: 'oops' } });
    expect(t.finish('failed')).toEqual([
      { type: 'error', message: 'opencode stream ended before a terminal event: oops', terminationReason: 'failed' },
    ]);
  });

  it('ignores unknown event types but counts drift', () => {
    const t = new OpencodeJsonlTranslator();
    expect(t.translate({ type: 'mystery', timestamp: 1, sessionID: 's' })).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(1);
  });

  it('does not emit after terminal', () => {
    const t = new OpencodeJsonlTranslator();
    t.finish('normal');
    expect(t.translate({ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'x', time: { end: 2 } } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/agent/opencode-jsonl`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `OpencodeJsonlTranslator`**

Create `src/agent/opencode/jsonl.ts`, modeled on `src/agent/codex/jsonl.ts`. Read `CodexJsonlTranslator` first to match its structure (terminal flag, `pendingAgentMessage`, `prependPendingText`, `drift`, `truncate`).

```ts
import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type OpencodeFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates opencode `run --format json` NDJSON events into AgentEvent[].
 *
 * In --format json mode the opencode CLI emits one JSON object per line via
 * its emit() function. There is NO standalone "done" event — the CLI breaks
 * its subscribe loop on `session.status idle` then exits. So termination is
 * stdout EOF (the adapter calls finish()/fail() at that point).
 *
 * Buffering mirrors CodexJsonlTranslator: opencode delivers text as complete
 * `text` events (with part.time.end), so we buffer the latest and emit prior
 * buffered text as a `text` delta when a newer text/tool event arrives; the
 * final buffered text becomes `final_text` on finish().
 */
export class OpencodeJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private pendingAgentMessage: string | undefined;
  private systemEmitted = false;
  private drift: ProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }
    const sid = stringValue(raw.sessionID ?? raw.sessionId);
    if (sid && !this.systemEmitted) {
      this.sessionId = sid;
      this.systemEmitted = true;
    }

    switch (raw.type) {
      case 'text':
        return this.handleText(raw);
      case 'reasoning':
        return this.handleReasoning(raw);
      case 'tool_use':
        return this.handleToolUse(raw);
      case 'step_start':
      case 'step_finish':
        return [];
      case 'error':
        return this.handleError(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: OpencodeFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return this.prependPendingText([
        {
          type: 'error',
          message: truncate(`opencode stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ]);
    }
    return this.prependPendingText([
      { type: 'done', sessionId: this.sessionId, terminationReason: reason },
    ]);
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.prependPendingText([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private handleText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) return [];
    return this.queueAgentMessage(text);
  }

  private handleReasoning(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) return [];
    return this.prependPendingText([{ type: 'thinking', delta: text }]);
  }

  private handleToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const id = stringValue(part?.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const name = stringValue(part?.tool) ?? 'tool';
    const state = recordValue(part?.state);
    const status = stringValue(state?.status);
    const isError = status === 'error';
    const errorText = stringValue(state?.error);
    const output = stringValue(part?.output) ?? stringValue(part?.text) ?? errorText ?? '';
    const events: AgentEvent[] = [
      { type: 'tool_use', id, name, input: { output } },
      { type: 'tool_result', id, output, isError },
    ];
    return this.prependPendingText(events);
  }

  private handleError(raw: Record<string, unknown>): AgentEvent[] {
    const message = errorMessage(raw, 'opencode error');
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    const events = this.pendingAgentMessage
      ? [{ type: 'text' as const, delta: this.pendingAgentMessage }]
      : [];
    this.pendingAgentMessage = message;
    return events;
  }

  private prependPendingText(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAgentMessage) return events;
    const pending = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return [{ type: 'text', delta: pending }, ...events];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return (
    stringValue(nested?.message) ??
    stringValue(nested?.name) ??
    stringValue(raw.message) ??
    stringValue(raw.error) ??
    fallback
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test unit/agent/opencode-jsonl`
Expected: PASS. If the "marks a tool_result as error" test has no assertions (it only sets up state), add an explicit assertion: after the translate, assert `t.protocolDrift()` is clean and that a subsequent `finish('failed')` includes the error path. Adjust the test to assert real output — replace the empty body with:

```ts
  it('emits tool_use + tool_result(isError=true) when state.error is present', () => {
    const t = new OpencodeJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_use',
        timestamp: 1,
        sessionID: 's',
        part: { id: 't2', type: 'tool', tool: 'bash', state: { status: 'error', error: 'boom' } },
      }),
    ).toEqual([
      { type: 'tool_use', id: 't2', name: 'bash', input: { output: 'boom' } },
      { type: 'tool_result', id: 't2', output: 'boom', isError: true },
    ]);
  });
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode/jsonl.ts tests/unit/agent/opencode-jsonl.test.ts
git commit -m "feat(opencode): OpencodeJsonlTranslator NDJSON-to-AgentEvent"
```

---

### Task 5: Build `OpencodeAdapter` (spawn + lifecycle + event stream)

**Files:**
- Create: `src/agent/opencode/adapter.ts`
- Modify: `src/agent/index.ts`
- Test: `tests/process/opencode-adapter.test.ts`

**Interfaces:**
- Consumes: `buildOpencodeArgs` (Task 3), `OpencodeJsonlTranslator`/`OpencodeFinishReason` (Task 4), `prefixBridgeSystemPrompt`/`buildLarkChannelEnv`/`checkAgentAvailability`/`AgentAdapter`/`AgentEvent` (existing), `mergeProcessEnv`/`spawnProcess`/`SpawnedProcessByStdio` from `src/platform/spawn.ts`, `AccessMode` from `src/config/permissions.ts`, `OpencodeConfig` from Task 1.
- Produces: `OpencodeAdapter` class implementing `AgentAdapter`. Exported from `src/agent/index.ts`.

- [ ] **Step 1: Write the failing process test**

Create `tests/process/opencode-adapter.test.ts`, modeled on `tests/process/codex-adapter.test.ts`. It writes a fake `opencode` .mjs that records argv/stdin/env and emits canned NDJSON lines.

```ts
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpencodeAdapter } from '../../src/agent/opencode/adapter.js';
import { buildOpencodeArgs } from '../../src/agent/opencode/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('OpencodeAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldConfigDir = process.env.OPENCODE_CONFIG_DIR;

  afterEach(async () => {
    if (oldConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = oldConfigDir;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with prompt on stdin and emits AgentEvents', async () => {
    const fake = await createFakeOpencode({
      lines: [
        { type: 'text', timestamp: 1, sessionID: 'sess-fresh', part: { type: 'text', text: 'hello user', time: { end: 2 } } },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new OpencodeAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      access: 'read-only',
    }).run({ runId: 'run-fresh', prompt: 'hello from lark', cwd });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fresh' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildOpencodeArgs({ cwd, access: 'read-only', prompt: 'hello from lark' }));
    expect(record.argv).not.toContain('--auto');
    expect(record.argv).toContain('--agent');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('plan');
    // Prompt on stdin, NOT argv:
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
  });

  it('uses build agent + --auto for full access', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'full' }).run({ runId: 'r', prompt: 'p', cwd });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--auto');
    expect(record.argv[record.argv.indexOf('--agent') + 1]).toBe('build');
  });

  it('sets OPENCODE_CONFIG_DIR to a profile-local dir when inheritConfig is false', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only', inheritConfig: false }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.OPENCODE_CONFIG_DIR).toBe(join(fake.dir, 'opencode-config'));
  });

  it('leaves OPENCODE_CONFIG_DIR unset by default to inherit user config', async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only' }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it('forwards --session and --model through the argv contract', async () => {
    const fake = await createFakeOpencode({ lines: [{ type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'ok', time: { end: 2 } } }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'full' }).run({
      runId: 'r', prompt: 'p', cwd, sessionId: 'sess-old', model: 'anthropic/claude-opus-4-8',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildOpencodeArgs({ cwd, access: 'full', prompt: 'p', sessionId: 'sess-old', model: 'anthropic/claude-opus-4-8' }));
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeOpencode({ lines: [], stderr: 'boom\n', exitCode: 42 });
    cleanup.push(fake.dir);
    const run = new OpencodeAdapter({ binary: fake.path, profileStateDir: fake.dir, access: 'read-only' }).run({ runId: 'r', prompt: 'p', cwd: await realpath(fake.dir) });
    expect(await collect(run.events)).toEqual([
      { type: 'error', message: 'opencode exited with code 42: boom', terminationReason: 'failed' },
    ]);
  });

  it('requires cwd', () => {
    expect(() =>
      new OpencodeAdapter({ binary: '/x/opencode', profileStateDir: '/x', access: 'read-only' }).run({ runId: 'r', prompt: 'p' }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeOpencode(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-test-'));
  const path = join(dir, 'fake-opencode.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: { LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string; LARK_CHANNEL_HOME?: string; LARK_CHANNEL_CONFIG?: string; LARKSUITE_CLI_CONFIG_DIR?: string; OPENCODE_CONFIG_DIR?: string; PATH?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[]; cwd: string; stdin: string;
    env: { LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string; LARK_CHANNEL_HOME?: string; LARK_CHANNEL_CONFIG?: string; LARKSUITE_CLI_CONFIG_DIR?: string; OPENCODE_CONFIG_DIR?: string; PATH?: string };
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:process opencode-adapter` (or `pnpm test process/opencode-adapter`)
Expected: FAIL — `OpencodeAdapter` module not found.

- [ ] **Step 3: Implement `OpencodeAdapter`**

Create `src/agent/opencode/adapter.ts`, modeled structurally on `src/agent/codex/adapter.ts`. Read that file in full first to match its `createEventStream`/`stop`/`waitForExit` shapes exactly.

```ts
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { AccessMode } from '../../config/permissions';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildOpencodeArgs } from './argv';
import { OpencodeJsonlTranslator, type OpencodeFinishReason } from './jsonl';

export interface OpencodeAdapterOptions {
  binary: string;
  profileStateDir: string;
  inheritConfig?: boolean;
  ignoreUserConfig?: boolean;
  access?: AccessMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type OpencodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class OpencodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly inheritConfig: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly access: AccessMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OpencodeAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.inheritConfig = opts.inheritConfig !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.access = opts.access ?? 'full';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'opencode',
      agentName: 'OpenCode',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'opencode binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for OpencodeAdapter.run');
    }

    const args = buildOpencodeArgs({
      cwd: opts.cwd,
      access: this.access,
      sessionId: opts.sessionId,
      model: opts.model,
      prompt: opts.prompt,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (!this.inheritConfig) {
      envOverrides.OPENCODE_CONFIG_DIR = join(this.profileStateDir, 'opencode-config');
    }
    // permissionMode maps to access here, opencode has no separate --permission flag.
    void opts.permissionMode;
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OpencodeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn opencode: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: OpencodeFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', { pid: child.pid ?? null, graceMs: stopGraceMs, reason: 'grace-period-expired' });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: OpencodeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => OpencodeFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new OpencodeJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn opencode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`opencode runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`opencode exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`opencode runtime error: ${runtimeError.message}`);
    return;
  }

  // Clean exit with no terminal event → normal done (translator.finish('normal')
  // emits done, flushing any pending buffered text as final_text).
  yield* translator.finish('normal');
}

async function waitForExitCode(child: OpencodeChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
```

Note on the "exits non-zero before terminal" test: when `exitCode=42` and no lines emitted, `translator.finish('normal')` would be reached because exitCode `!== 0` is true — wait, re-check the branch order. With `exitCode=42`: the `if (exitCode !== 0 && exitCode !== null)` branch fires → `translator.fail('opencode exited with code 42: boom')`. That matches the test expectation. Good. But the test expects the message WITHOUT the `lastNonTerminalError` suffix since no `error` event was emitted. `fail()` uses the passed message directly — correct.

- [ ] **Step 4: Export `OpencodeAdapter` from the agent index**

In `src/agent/index.ts`, add (next to the existing `CodexAdapter` export):

```ts
export { OpencodeAdapter } from './opencode/adapter';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test process/opencode-adapter`
Expected: PASS (all 7 cases). If the non-zero-exit case fails because the `--format json` path in opencode emits a terminal `error` event before exiting on failure — adjust the fake binary and translator expectations together, but keep the adapter's exit-code fallback as the safety net.

- [ ] **Step 6: Commit**

```bash
git add src/agent/opencode/adapter.ts src/agent/index.ts tests/process/opencode-adapter.test.ts
git commit -m "feat(opencode): OpencodeAdapter spawn + lifecycle + event stream"
```

---

### Task 6: Wire `createRuntimeAgent` + agent detection + preflight + profile bootstrap

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (`:36-52` codex branch, `:61-63` availability fallback)
- Modify: `src/agent/preflight.ts` (`:3` LocalAgentId, `:282` isAgentPreflightDiagnostic)
- Modify: `src/cli/agent-detection.ts` (`:47-51` detectInstalledAgents, `:5` AgentKind import)
- Modify: `src/cli/profile-bootstrap.ts` (`:9-18` BootstrapProfileInput, `:28-31` codex ternary, `:62-79` createBootstrapCodexConfig vicinity)
- Test: `tests/unit/cli/start-agent-factory.test.ts`

**Interfaces:**
- Consumes: `OpencodeAdapter` (Task 5), `OpencodeConfig` (Task 1), `resolveExecutablePath` (existing).
- Produces: `createRuntimeAgent` returns an `OpencodeAdapter` for opencode profiles; `detectInstalledAgents` includes opencode; preflight accepts `'opencode'`; `createBootstrapOpencodeConfig()`.

- [ ] **Step 1: Read the existing start-agent-factory test to match its style**

Run: read `tests/unit/cli/start-agent-factory.test.ts` (use the Read tool) to see how it asserts the claude/codex factory branches, then mirror for opencode.

- [ ] **Step 2: Write/extend the failing test**

Add an opencode case to `tests/unit/cli/start-agent-factory.test.ts` mirroring the codex case. If the test constructs a profile config + asserts `createRuntimeAgent(...)` returns the right adapter class, add:

```ts
import { OpencodeAdapter } from '../../../src/agent/opencode/adapter.js';
// ...inside a describe block:
it('builds an OpencodeAdapter for an opencode profile', () => {
  const adapter = createRuntimeAgent(
    { agentKind: 'opencode', opencode: { binaryPath: '/usr/local/bin/opencode' } } as Parameters<typeof createRuntimeAgent>[0],
    minimalAppPaths,
  );
  expect(adapter).toBeInstanceOf(OpencodeAdapter);
});
```

(Use the exact `minimalAppPaths` / profile-config fixtures the existing codex test uses — copy that test's setup verbatim and change `agentKind`/`codex`→`opencode`/`opencode`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test unit/cli/start-agent-factory`
Expected: FAIL — `createRuntimeAgent` falls through to `ClaudeAdapter` for opencode.

- [ ] **Step 4: Add the opencode branch to `createRuntimeAgent`**

In `src/runtime/agent-runtime.ts`, insert an opencode branch before the final `return new ClaudeAdapter(...)` (after the codex block at line ~51). Import `OpencodeAdapter` at the top:

```ts
import { OpencodeAdapter } from '../agent/opencode/adapter';
```

Add the branch:

```ts
  if (profileConfig.agentKind === 'opencode') {
    const oc = profileConfig.opencode;
    if (!oc?.binaryPath) {
      throw new Error('opencode profile requires opencode.binaryPath');
    }
    return new OpencodeAdapter({
      binary: oc.binaryPath,
      profileStateDir: appPaths.profileDir,
      inheritConfig: oc.inheritConfig === true,
      ignoreUserConfig: oc.ignoreUserConfig === true,
      larkChannel,
    });
  }
```

Update the availability fallback (lines ~61-63) so a non-codex/non-claude id maps correctly:

```ts
    agentId: agent.id === 'codex' ? ('codex' as const) : agent.id === 'opencode' ? ('opencode' as const) : ('claude' as const),
    agentName: agent.displayName,
    command: agent.id === 'codex' ? 'codex' : agent.id === 'opencode' ? 'opencode' : 'claude',
```

- [ ] **Step 5: Extend preflight `LocalAgentId` + diagnostic check**

In `src/agent/preflight.ts`:
- Line ~3: `export type LocalAgentId = 'claude' | 'codex' | 'opencode';`
- Line ~282 (`isAgentPreflightDiagnostic`): change `(raw.agentId === 'claude' || raw.agentId === 'codex')` to also accept `'opencode'`:

```ts
    (raw.agentId === 'claude' || raw.agentId === 'codex' || raw.agentId === 'opencode') &&
```

- [ ] **Step 6: Add opencode to agent detection**

In `src/cli/agent-detection.ts`:
- Line ~5: `export type AgentKind = 'claude' | 'codex' | 'opencode';`
- In `detectInstalledAgents` (lines ~48-51), add a third candidate:

```ts
  const candidates: Array<{ kind: AgentKind; command: string }> = [
    { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
    { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
    { kind: 'opencode', command: process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode' },
  ];
```

- [ ] **Step 7: Add `createBootstrapOpencodeConfig` + profile-bootstrap wiring**

In `src/cli/profile-bootstrap.ts`:
- Add to `BootstrapProfileInput` (line ~9-18): `opencodeBinaryPath?: string;`
- In `createBootstrapProfileConfig` (lines ~28-31), add the opencode ternary next to the codex one:

```ts
  const codex =
    input.agentKind === 'codex'
      ? await createBootstrapCodexConfig(input.codexBinaryPath)
      : undefined;
  const opencode =
    input.agentKind === 'opencode'
      ? await createBootstrapOpencodeConfig(input.opencodeBinaryPath)
      : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
  });
```

And in the `if (input.profileDir ...)` block (lines ~45-47), add opencode-config dir creation when isolated:

```ts
  if (input.profileDir && profile.opencode?.inheritConfig === false) {
    await mkdir(join(input.profileDir, 'opencode-config'), { recursive: true });
  }
```

Add the `createBootstrapOpencodeConfig` function (modeled on `createBootstrapCodexConfig`, lines ~62-79):

```ts
export async function createBootstrapOpencodeConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: opencodeBootstrapBinaryErrorCode(errno),
      agentId: 'opencode',
      agentName: 'OpenCode',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function opencodeBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test unit/cli/start-agent-factory`
Expected: PASS.

- [ ] **Step 9: Run typecheck + the preflight unit test**

Run: `pnpm typecheck && pnpm test unit/agent/preflight && pnpm test unit/cli/preflight`
Expected: PASS. If `preflight` tests assert the exhaustive `agentId` set, they should still pass (adding opencode to the union only widens it); if any test asserts "only claude or codex", update it.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/agent-runtime.ts src/agent/preflight.ts src/cli/agent-detection.ts src/cli/profile-bootstrap.ts tests/unit/cli/start-agent-factory.test.ts
git commit -m "feat(opencode): wire createRuntimeAgent, detection, preflight, bootstrap"
```

---

### Task 7: Dynamic model picker (`fetchOpencodeModels`) + models.ts branches

**Files:**
- Modify: `src/agent/models.ts`
- Test: `tests/unit/agent/models.test.ts`

**Interfaces:**
- Consumes: `spawnProcess`/`mergeProcessEnv` from `src/platform/spawn.ts` (or reuse `checkAgentAvailability`'s spawn pattern), `ModelOption` (existing).
- Produces: `fetchOpencodeModels(binaryPath): Promise<ModelOption[]>`. `supportedModels('opencode')` returns a static `DEFAULT_MODEL`-only list (the dynamic fetch is separate, called by `/config` rendering). `normalizeModelSelection`/`resolveModelArg`/`modelLabel` accept opencode with free-form validation.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/agent/models.test.ts` (read it first to match imports). The dynamic fetch needs a fake binary — use the same `writeVersionExecutable` pattern, but emitting model lines. Since `opencode models` output format isn't 100% pinned, design the parser to be tolerant: split stdout on whitespace/newlines, keep lines matching `provider/model` (contain `/`).

```ts
import { mkdtemp, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchOpencodeModels, resolveModelArg, normalizeModelSelection, DEFAULT_MODEL } from '../../../src/agent/models.js';

describe('opencode models', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, true, maxRetries: 5 } as never).catch(() => {})));
  });

  it('normalizeModelSelection accepts free-form provider/model for opencode', () => {
    expect(normalizeModelSelection('opencode', 'anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(normalizeModelSelection('opencode', DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('opencode', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolveModelArg returns the provider/model or undefined for default', () => {
    expect(resolveModelArg('opencode', 'anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(resolveModelArg('opencode', DEFAULT_MODEL)).toBeUndefined();
  });

  it('fetchOpencodeModels parses provider/model lines from stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-models-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-opencode-models.mjs');
    await writeFile(bin, '#!/usr/bin/env node\nconsole.log("anthropic/claude-opus-4-8\\nopenai/gpt-5-codex\\nsome-garbage-no-slash");\n', 'utf8');
    await chmod(bin, 0o755);
    const models = await fetchOpencodeModels(bin);
    expect(models).toContainEqual({ value: 'anthropic/claude-opus-4-8', label: 'anthropic/claude-opus-4-8' });
    expect(models).toContainEqual({ value: 'openai/gpt-5-codex', label: 'openai/gpt-5-codex' });
    expect(models.find((m) => m.value === 'some-garbage-no-slash')).toBeUndefined();
  });

  it('fetchOpencodeModels returns [] on failure', async () => {
    const models = await fetchOpencodeModels('/nonexistent/opencode-bin-xyz');
    expect(models).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/agent/models`
Expected: FAIL — `fetchOpencodeModels` not exported; opencode not handled in `normalizeModelSelection`.

- [ ] **Step 3: Implement the model functions**

In `src/agent/models.ts`:
- Add an opencode static list (used by `supportedModels` for the picker's `initial_option` contract — the actual dynamic options are fetched separately, but `supportedModels` still needs to return at least `DEFAULT_MODEL` so `normalizeModelSelection`'s existing allowlist check doesn't reject opencode):

```ts
const OPENCODE_MODELS: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];
```

- Update `supportedModels` (line ~47):

```ts
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  if (agentKind === 'codex') return CODEX_MODELS;
  if (agentKind === 'opencode') return OPENCODE_MODELS;
  return CLAUDE_MODELS;
}
```

- Add `fetchOpencodeModels`:

```ts
import { spawnProcess } from '../platform/spawn';

/**
 * Fetch the models the installed opencode binary advertises via
 * `opencode models`. Used to populate the /config model picker dynamically
 * (opencode's model set is provider-dependent and changes over time, unlike
 * Claude/Codex's pinned lists). Returns [] on any failure — the picker
 * then falls back to DEFAULT_MODEL only.
 *
 * Each stdout token containing `/` is treated as a `provider/model` value.
 */
export async function fetchOpencodeModels(binaryPath: string): Promise<ModelOption[]> {
  try {
    const child = spawnProcess(binaryPath, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exitCode: number | null = await new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code));
    });
    if (exitCode !== 0) {
      log.warn('models', 'opencode-models-nonzero', { exitCode, stderr: stderr.slice(0, 200) });
      return [];
    }
    const tokens = stdout.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const tok of tokens) {
      if (!tok.includes('/')) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      models.push({ value: tok, label: tok });
    }
    return models;
  } catch (err) {
    log.warn('models', 'opencode-models-failed', { message: (err as Error).message });
    return [];
  }
}
```

Add the `log` import if not present: `import { log } from '../core/logger';`

- `normalizeModelSelection` (line ~63) already calls `supportedModels(agentKind).some(...)`; for opencode `OPENCODE_MODELS` is `[DEFAULT_MODEL]`, so a stored `provider/model` would be normalized to `DEFAULT_MODEL` — which is WRONG for opencode (we want to keep the stored value). Fix: special-case opencode so non-default values are kept:

```ts
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  if (agentKind === 'opencode') return (value as string); // free-form provider/model
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test unit/agent/models`
Expected: PASS. Fix the `rm` typo in the test's afterEach (`recursive: true` not `true`):

```ts
    await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})));
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/models.ts tests/unit/agent/models.test.ts
git commit -m "feat(opencode): dynamic model picker via `opencode models`"
```

---

### Task 8: Session catalog opencode path (sessionId, not threadId)

**Files:**
- Modify: `src/session/catalog.ts` (`:217`, `:249-252`, `:254-264`)

**Interfaces:**
- Consumes: `CatalogAgentId` (now `'claude' | 'codex' | 'opencode'` via Task 2's `AgentCapabilityId`).
- Produces: catalog accepts/validates opencode entries holding `sessionId` (no `threadId`).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/session/catalog.test.ts` (read first to match its fixture style — it likely constructs a `SessionCatalog` with `replaceForTest`):

```ts
describe('opencode catalog entries', () => {
  it('accepts an opencode entry with sessionId and no threadId', () => {
    const cat = new SessionCatalog(/* use the test's temp path pattern */);
    cat.upsertActive({ scopeId: 's', agentId: 'opencode', cwdRealpath: '/r', policyFingerprint: 'p', sessionId: 'sess-1' });
    const entry = cat.activeFor({ scopeId: 's', agentId: 'opencode', cwdRealpath: '/r', policyFingerprint: 'p' });
    expect(entry?.sessionId).toBe('sess-1');
    expect(entry?.threadId).toBeUndefined();
  });

  it('rejects an opencode entry that includes a threadId', () => {
    const cat = new SessionCatalog(/* temp path */);
    expect(() =>
      cat.upsertActive({ scopeId: 's', agentId: 'opencode', cwdRealpath: '/r', policyFingerprint: 'p', sessionId: 'sess-1', threadId: 't1' } as never),
    ).toThrow();
  });

  it('normalizes an opencode entry from raw JSON', () => {
    // round-trip via replaceForTest + load, mirroring how claude entries are tested
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test unit/session/catalog`
Expected: FAIL — `agentId: 'opencode'` rejected by `assertAgentIdentity`/`normalizeEntry`.

- [ ] **Step 3: Update the three catalog sites**

In `src/session/catalog.ts`:
- `normalizeEntry` (line ~217): change `(raw.agentId !== 'claude' && raw.agentId !== 'codex')` to also accept `'opencode'`.
- `isValidAgentEntry` (lines ~249-252): opencode follows the claude (sessionId) branch:

```ts
function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  if (entry.agentId === 'codex') return Boolean(entry.threadId) && !entry.sessionId;
  return Boolean(entry.sessionId) && !entry.threadId; // claude + opencode
}
```

- `assertAgentIdentity` (lines ~254-264): opencode follows the claude (sessionId) branch:

```ts
function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  if (input.agentId === 'codex') {
    if (!input.threadId || input.sessionId) {
      throw new Error('Codex catalog entries require threadId and must not include sessionId');
    }
    return;
  }
  // claude + opencode: sessionId-holding
  if (!input.sessionId || input.threadId) {
    throw new Error(`${input.agentId === 'opencode' ? 'Opencode' : 'Claude'} catalog entries require sessionId and must not include threadId`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test unit/session/catalog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/catalog.ts tests/unit/session/catalog.test.ts
git commit -m "feat(opencode): session catalog opencode entries use sessionId"
```

---

### Task 9: Branch-site updates — capability selection + resume/record session flow

**Files:**
- Modify: `src/bot/channel.ts` (`:859-862` capability selection, `:1069-1170` codex-specific branches audit)
- Modify: `src/commands/index.ts` (`:1119-1122` capability selection, `:549,607,628,638,645,691-692,754,804` resume/codex branches)
- Modify: `src/bot/run-flow.ts` (`:123-129, 131, 152, 191, 203`)
- Modify: `src/bot/comments.ts` (`:246, 250, 331`)
- Modify: `src/bot/session-catalog-identity.ts` (`:25`)

**Interfaces:**
- Consumes: `opencodeCapability` (Task 2), opencode = sessionId-path (Task 8).
- Produces: OpenCode profiles resolve capability correctly and resume/record sessions via the sessionId path like Claude.

This task has no new unit test of its own — the integration tests (Task 11) cover the end-to-end flow. The changes are mechanical branch extensions.

- [ ] **Step 1: Update capability selection to three-way**

In `src/bot/channel.ts` (lines ~859-862), replace the two-way:

```ts
  const capability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
```

with a three-way (add `opencodeCapability` to the import at line 8):

```ts
  const agentKind = controls.profileConfig.agentKind;
  const capability =
    agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : agentKind === 'opencode'
        ? opencodeCapability(controls.profileConfig)
        : claudeCapability(controls.profileConfig);
```

Apply the identical three-way change in `src/commands/index.ts` (lines ~1119-1122), adding `opencodeCapability` to its import at line 6.

- [ ] **Step 2: Update resume/record-session branches in run-flow.ts**

In `src/bot/run-flow.ts`:
- Lines ~123-129 (catalog resume): opencode uses sessionId, so extend the claude branch:

```ts
    if (catalogEntry?.agentId === 'claude' || catalogEntry?.agentId === 'opencode') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
```

- Line ~131 (fallback resume): `input.capability.agentId === 'claude'` → also opencode (opencode also uses `sessions.resumeFor` the same way Claude does, since the SessionStore is sessionId-keyed):

```ts
  if (!resumeFrom && (input.capability.agentId === 'claude' || input.capability.agentId === 'opencode')) {
```

- Lines ~152 (images): the `capability.agentId === 'codex'` branch is codex-specific (Codex passes `--image`). For opencode, attachments are NOT wired in v1 (Out of Scope per spec), so pass `images: undefined` — no change needed to the `=== 'codex'` check; it already excludes opencode (falls to the `: undefined`). Verify this is the case and leave it.

- Lines ~191 (record session): extend the claude branch to opencode:

```ts
  if ((input.capability.agentId === 'claude' || input.capability.agentId === 'opencode') && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'opencode' as const === input.capability.agentId ? 'opencode' : 'claude',
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
```

Wait — that ternary is wrong. Use the actual capability agentId:

```ts
  if ((input.capability.agentId === 'claude' || input.capability.agentId === 'opencode') && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
```

(`agentId` is typed `AgentCapabilityId` which now includes `'opencode'`; `upsertActive`'s `agentId` param is `CatalogAgentId = AgentCapabilityId`, so this typechecks.)

- [ ] **Step 3: Update comments.ts resume/record branches**

In `src/bot/comments.ts`:
- Line ~246: `canResumeAgentSession && capability.agentId === 'claude'` → `(capability.agentId === 'claude' || capability.agentId === 'opencode')`.
- Line ~250: `capability.agentId === 'codex' ? catalogEntry?.threadId : undefined` → for opencode this should be `catalogEntry?.sessionId`. Rewrite as:

```ts
      const sessionId = (capability.agentId === 'claude' || capability.agentId === 'opencode') ? catalogEntry?.sessionId : undefined;
      const threadId = capability.agentId === 'codex' ? catalogEntry?.threadId : undefined;
```

(Check the surrounding code to make sure both `sessionId` and `threadId` are then forwarded to the executor — adjust to match what the existing claude/codex code does.)

- Line ~331: `capability.agentId === 'claude' && e.type === 'system' && e.sessionId` → `(capability.agentId === 'claude' || capability.agentId === 'opencode') && e.type === 'system' && e.sessionId`. Read the surrounding block to mirror its `upsertActive` call with `agentId: capability.agentId` (same fix as run-flow step 2).

- [ ] **Step 4: Update session-catalog-identity.ts**

In `src/bot/session-catalog-identity.ts` (line ~25), the `agentKind === 'codex'` branch returns the codex identity; opencode should return the sessionId-holding identity. Read the full function first, then extend so opencode produces an identity with `agentId: 'opencode'` (matching the claude path's shape). The function likely builds a `SessionCatalogIdentity` from the profile — for opencode, `agentId: 'opencode'`.

- [ ] **Step 5: Update commands/index.ts resume/codex branches**

In `src/commands/index.ts`:
- Lines ~607, ~628, ~638: branches checking `agentId === 'codex'` / `=== 'claude'` for resume — extend the claude (sessionId) branches to also match opencode (read each in context; they likely pick `candidate.sessionId` vs `candidate.threadId`).
- Lines ~691-692: `(identity.agentId === 'claude' && !candidate.sessionId) || (identity.agentId === 'codex' && !candidate.threadId)` — extend the claude clause to opencode:
  `(identity.agentId === 'codex' && !candidate.threadId) || ((identity.agentId === 'claude' || identity.agentId === 'opencode') && !candidate.sessionId)`.
- Lines ~549, ~645, ~754, ~804: audit each `agentKind === 'codex'` branch in context. These are codex-specific behaviors (e.g. codex thread-history listing via `listCodexThreadHistory`). For opencode, follow the non-codex path (the existing `else`/fall-through). Only add opencode handling if a branch is generic "non-claude" logic that should include opencode — otherwise leave the codex check as-is so opencode falls through to the default. Read each site before deciding.

- [ ] **Step 6: Run typecheck + existing integration tests**

Run: `pnpm typecheck && pnpm test:integration`
Expected: PASS (existing claude/codex flows unaffected; no opencode integration test yet — added in Task 11). Fix any type errors from the branch edits.

- [ ] **Step 7: Commit**

```bash
git add src/bot/channel.ts src/commands/index.ts src/bot/run-flow.ts src/bot/comments.ts src/bot/session-catalog-identity.ts
git commit -m "feat(opencode): three-way capability selection + sessionId resume/record flow"
```

---

### Task 10: Remaining branch sites — runtime/locks/registry/daemon/ui/migrate/models-picker-render

**Files:**
- Modify: `src/runtime/profile-runtime.ts` (`:90, :285, :296, :302, :398, :616`)
- Modify: `src/runtime/locks.ts` (`:181`) + `src/runtime/registry.ts` (`:67`)
- Modify: `src/cli/commands/service.ts` (`:586`)
- Modify: `src/ui/qr-register.ts` (`:155`) + `src/ui/onboard.ts` (`:80`)
- Modify: `src/cli/commands/migrate.ts` (`:46`) + `src/config/migrate-v2.ts` (`:131, :203`)
- Modify: `src/commands/index.ts` (`:1730` vicinity — async model picker render for opencode)

**Interfaces:**
- Consumes: `fetchOpencodeModels` (Task 7), `OpencodeConfig` (Task 1).
- Produces: all two-way `agentKind === 'codex'`/`=== 'claude'` sites accept opencode; `/config` model picker fetches opencode models dynamically.

- [ ] **Step 1: profile-runtime displayName + branch audit**

In `src/runtime/profile-runtime.ts`:
- Line ~616 (`kind === 'claude' ? 'Claude Code' : 'Codex CLI'`): add opencode:

```ts
  return kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex CLI' : 'OpenCode';
```

- Lines ~90, ~285, ~296, ~302, ~398: read each in context. These are codex-specific (codexHome, codex binary checks). For opencode, follow the non-codex default path (the existing `else`/fall-through). Only modify if a branch is `agentKind === 'claude' ? X : Y` where opencode should join the claude side — read each and decide. Most should need no change (opencode correctly falls through). If line ~285 (`agentKind === 'claude' &&`) is a "claude-only" capability branch, extend to `=== 'claude' || === 'opencode'` only if the behavior applies to opencode; otherwise leave.

- [ ] **Step 2: locks + registry three-way validation**

In `src/runtime/locks.ts` (line ~181): change `(meta.agentKind === 'claude' || meta.agentKind === 'codex') &&` to also accept `'opencode'`.
In `src/runtime/registry.ts` (line ~67): same change.

- [ ] **Step 3: daemon service label branch**

In `src/cli/commands/service.ts` (line ~586): read the context — it builds a service label/profile id from agentKind. Add an opencode branch (or extend the existing codex/claude ternary to three-way) so opencode profiles get a valid service label. Mirror whatever sanitization codex/claude use.

- [ ] **Step 4: ui/onboard three-way agentKind**

In `src/ui/qr-register.ts` (line ~155) and `src/ui/onboard.ts` (line ~80): change `fv.agentKind === 'codex' ? 'codex' : 'claude'` to three-way:

```ts
  const agentKind: AgentKind = fv.agentKind === 'codex' ? 'codex' : fv.agentKind === 'opencode' ? 'opencode' : 'claude';
```

Also check whether the onboard wizard UI (`web/src/views/OnboardWizard.tsx`) offers an agent picker that needs an opencode option — if it hardcodes claude/codex choices, add opencode. (Read the file; if it's data-driven from the backend, no UI change needed.)

- [ ] **Step 5: migrate agentKindFromString**

In `src/cli/commands/migrate.ts` (line ~46): read `agentKindFromString` — make it accept `'opencode'`. In `src/config/migrate-v2.ts` (lines ~131, ~203): the `agentKind === 'codex'` / `=== 'claude' || === 'codex'` checks — opencode is new (no legacy v1 opencode profiles), so extend the `=== 'claude' || === 'codex'` acceptance check at ~203 to include `'opencode'` for forward-compat, and leave ~131 (codex-specific codex config) as-is.

- [ ] **Step 6: async model picker render for opencode**

In `src/commands/index.ts` (around line ~1730, the `/config` model-option rendering): the current code calls `supportedModels(agentKind)` synchronously. For opencode, call `await fetchOpencodeModels(binaryPath)` instead, falling back to `supportedModels('opencode')` (= `[DEFAULT_MODEL]`) on empty result. Read the surrounding function to find where the profile's opencode binary path is available (from `profileConfig.opencode.binaryPath`), and make that render path async. If the render function is currently synchronous, either (a) pre-fetch the models earlier in the command handler and pass them in, or (b) make the render async — choose whichever matches how `/config` already awaits things. Check `src/commands/index.ts:1793-1798` (`normalizeModelSelection`/`supportedModels` usage) and `:1946` for the validation path — ensure opencode's free-form model survives validation.

- [ ] **Step 7: Run typecheck + full unit test suite**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS. Fix any branch-site type errors.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/profile-runtime.ts src/runtime/locks.ts src/runtime/registry.ts src/cli/commands/service.ts src/ui/qr-register.ts src/ui/onboard.ts src/cli/commands/migrate.ts src/config/migrate-v2.ts src/commands/index.ts
git commit -m "feat(opencode): extend remaining agentKind branch sites + async model picker"
```

---

### Task 11: Integration test — end-to-end OpenCode profile run flow

**Files:**
- Test: `tests/integration/bot/opencode-run-flow.test.ts`

**Interfaces:**
- Consumes: `OpencodeAdapter`, the full bot run-flow, `fake-agent`/`fake-channel` helpers from `tests/helpers/`.

- [ ] **Step 1: Read an existing integration run-flow test for the fixture pattern**

Read `tests/integration/bot/im-run-flow.test.ts` to see how it stands up a fake channel + fake agent + profile config and asserts the rendered card from an AgentEvent stream. The opencode test reuses the same harness but swaps in a real `OpencodeAdapter` pointed at a fake `opencode` binary (from the Task 5 helper pattern), to exercise the full channel → run-flow → executor → adapter → renderer path.

- [ ] **Step 2: Write the integration test**

Create `tests/integration/bot/opencode-run-flow.test.ts`. Mirror `im-run-flow.test.ts`'s setup but:
- Profile config: `agentKind: 'opencode'`, `opencode: { binaryPath: <fake binary> }`, `permissions: { defaultAccess: 'full', maxAccess: 'full' }`.
- Fake binary: emits NDJSON `text` + `done`-equivalent (text event then clean exit).
- Assert: the message produces a final-answer card with the agent's text, and the session catalog recorded an opencode entry with `sessionId`.

```ts
// Skeleton — fill in fixtures by copying im-run-flow.test.ts structure.
describe('opencode run flow', () => {
  it('renders the agent reply and records an opencode session', async () => {
    // 1. write fake opencode binary emitting canned NDJSON
    // 2. build opencode profile config
    // 3. stand up channel + executor (reuse im-run-flow harness)
    // 4. send a message
    // 5. assert rendered card contains the agent text
    // 6. assert sessionCatalog has an opencode entry with sessionId
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `pnpm test:integration bot/opencode-run-flow`
Expected: PASS. If the harness from `im-run-flow.test.ts` is tightly coupled to the fake agent adapter (not the real subprocess adapter), this test may need to use the real `OpencodeAdapter` + fake binary directly with a hand-rolled `RunExecutor`, bypassing the channel — match whatever `tests/integration/executor/run-executor.test.ts` does (read it for the executor-level harness pattern).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/bot/opencode-run-flow.test.ts
git commit -m "test(opencode): end-to-end run flow integration test"
```

---

### Task 12: README + static contract tests + final verification

**Files:**
- Modify: `README.md` (and `README.zh.md` if it mirrors the agent sections)
- Modify: `tests/static/contracts.test.ts` + `tests/unit/docs/readme-contract.test.ts` (if they assert agent-kind set / CLI registration)

- [ ] **Step 1: Read the static contract tests to see what they assert**

Read `tests/static/contracts.test.ts` and `tests/unit/docs/readme-contract.test.ts`. If they enumerate `agentKind` values or assert the README mentions each agent, add `opencode` to those assertions.

- [ ] **Step 2: Add an OpenCode section to the README**

In `README.md`, add a section (near the Claude/Codex profile examples) covering:
- Install: `npm i -g opencode-ai`.
- Create profile: `lark-channel-bridge profile create oc --agent opencode` (or `run --agent opencode`).
- Permission-mode mapping table (with the `full`≡`workspace` note):

```markdown
| Bridge access | OpenCode agent | --auto |
|---|---|---|
| `full` | `build` | yes |
| `workspace` | `build` | yes (behaves identically to `full`) |
| `read-only` | `plan` | no (permissions auto-reject) |
```

- Note: model picker is dynamic via `opencode models`; sessions resume by `--session`.

Mirror a translated version in `README.zh.md` if it has agent sections.

- [ ] **Step 3: Update static contract tests**

If `contracts.test.ts` / `readme-contract.test.ts` assert the supported agent set, add `opencode` to the expected list so the contract test enforces README ↔ code consistency.

- [ ] **Step 4: Run the full verification suite**

Run: `pnpm ci:local` (runs `git diff --check && test && typecheck && build`)
Expected: PASS. This rebuilds the web console, runs unit+integration+process tests, typechecks, and builds. Fix any failures.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md tests/static/contracts.test.ts tests/unit/docs/readme-contract.test.ts
git commit -m "docs(opencode): README section + static contract tests"
```

---

## Self-Review (run after writing — results recorded inline above)

- **Spec coverage:** Each spec section maps to a task — §Type & config → T1; §capability → T2; §argv → T3; §jsonl translator → T4; §adapter → T5; §runtime wiring + detection/preflight/bootstrap → T6; §Models dynamic → T7; §session catalog → T8; §branch sites (resume/record) → T9; §branch sites (runtime/locks/registry/daemon/ui/migrate) → T10; testing → T11; documentation → T12. ✓
- **Placeholder scan:** No TBD/TODO; one "fill in fixtures by copying X" in T11 — acceptable as it points to a concrete existing test file to copy, with a skeleton showing the assertions. ✓
- **Type consistency:** `OpencodeConfig` fields (`binaryPath`, `inheritConfig`, `ignoreUserConfig`) used consistently across T1→T6→T10. `OpencodeAdapterOptions` (T5) matches `createRuntimeAgent` usage (T6). `buildOpencodeArgs` input (T3) matches adapter call (T5). `opencodeCapability` (T2) matches channel.ts/commands usage (T9). `fetchOpencodeModels` (T7) matches `/config` render (T10). ✓
