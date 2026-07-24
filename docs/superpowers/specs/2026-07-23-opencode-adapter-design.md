# OpenCode Adapter Design

Date: 2026-07-23
Status: Approved (brainstorming complete, ready for implementation plan)

## Goal

Add an OpenCode agent adapter to `lark-channel-bridge`, alongside the existing Claude and Codex adapters. A Feishu message routed to an OpenCode profile spawns a local `opencode` run; the streaming NDJSON reply renders back as an interactive Lark card via the existing `AgentEvent` → `RunState` → renderer pipeline.

## Context

The bridge's core contract is `AgentEvent` (`src/agent/types.ts`): every adapter emits the same event stream, which `RunState` (`src/card/run-state.ts`) folds and the card/text renderers consume. Both existing adapters implement the same `AgentAdapter` interface. Adding a new agent means a new adapter + protocol translator + an entry in `createRuntimeAgent` (`src/runtime/agent-runtime.ts`) + a new `AgentKind`/capability + wiring at ~20 branch sites that currently check `agentKind === 'codex'`.

OpenCode (npm `opencode-ai`, binary `opencode`) CLI surface, confirmed via docs + source:

- Headless run: `opencode run [message] --format json` → NDJSON event stream on stdout.
- In `--format json` mode, the CLI emits NDJSON lines via its `emit()` function. Each line envelope: `{"type","timestamp","sessionID", ...data}`. The emitted event `type` values are: `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`, `error`.
- The underlying SDK subscribe stream (used only for the formatted UI in `--format default`) emits `message.part.updated` / `session.status` / `session.error` / `permission.asked`. **These are NOT emitted in `--format json` mode** — the translator only handles the emitted `emit()` types above. (They are listed here only because their `part` field shapes mirror what `emit()` serializes into the `tool_use`/`text`/`reasoning` events: `part.type`, `part.state.status` `completed`/`error`/`running`, `part.tool`, `part.text`, `part.state.error`, `part.id`, `part.time.end`.)
- `session.status` with `status.type === "idle"` is the stream-termination signal in the subscribe stream; in `--format json` mode the loop breaks on the same condition and the process then exits, so the translator treats process stdout EOF (or an emitted terminal `error`) as termination. (Confirmed in §Error Handling.)
- Session resume: `--session <id>` (explicit), `--continue` (last session), `--fork`. Session IDs are first-class.
- Permission: `--auto` auto-approves; without `--auto` in non-interactive mode, `permission.asked` events are auto-rejected.
- Model: `--model provider/model` (e.g. `anthropic/claude-opus-4-8`), `--agent`, `--variant`.
- Working dir: `--dir <path>`.
- Files/images: `--file`/`-f` (max 10 MiB, inlined as `data:` URIs locally; MIME detected).
- Config isolation: `OPENCODE_CONFIG` (config file path) and `OPENCODE_CONFIG_DIR` (config directory, overrides `.opencode`) env vars. Default global config `~/.config/opencode/opencode.json`. No direct equivalent of `CODEX_HOME` for a state dir, but `OPENCODE_CONFIG_DIR` gives per-profile config isolation.
- `opencode models` lists supported models (used for the dynamic model picker).
- Prompt input: positional arg joined with spaces; stdin consumed when not a TTY (concatenated with `\n` if both present).

## Key Decisions (from brainstorming)

1. **Run mode: direct.** Spawn one `opencode run` subprocess per run (like Codex), read stdout NDJSON, translate to `AgentEvent`. No `opencode serve` server lifecycle. Rationale: matches existing adapter architecture, no server/port/health-check management, simpler error handling and process isolation.
2. **Permission mapping (three-layer → OpenCode):**
   - `full` → `--agent build --auto`
   - `workspace` → `--agent build --auto` (behaves identically to `full`; no workspace-write middle ground in OpenCode — documented limitation)
   - `read-only` → `--agent plan` (no `--auto`; permissions auto-rejected)
3. **Session model: `opencode-session`.** New `AgentSessionKind` value (not reuse of `claude-session`). OpenCode uses session IDs (`--session <id>`), matching the "resume this session" shape. `SessionCatalog` stores OpenCode entries in the `sessionId` field (same shape as Claude, not `threadId`).
4. **Session resume: `--session <id>`.** Explicit session ID (not `--continue`), so the bridge controls exactly which session resumes across concurrent chats/topics.
5. **Config block: `OpencodeConfig`.** New per-profile config block (like `CodexConfig`) holding `binaryPath` + isolation flags. Binary detection via `LARK_CHANNEL_OPENCODE_BIN` env or PATH `opencode`.
6. **Model picker: dynamic.** Fetch via `opencode models` each time the model selector opens (option B). Falls back to `DEFAULT_MODEL` only on failure.
7. **Prompt injection: `stdin-prefix`.** System prompt + user message concatenated, written to the subprocess stdin (same Windows-safe approach as Codex — avoids argv `<`/`>` redirection). `OpencodeCapability.promptInjection = 'stdin-prefix'`.
8. **Adapter structure: option A.** Three files mirroring Codex: `adapter.ts` (spawn + lifecycle) + `jsonl.ts` (protocol translator class) + `argv.ts` (arg builder). Translator is independently unit-testable.

## Architecture

### New files

```
src/agent/opencode/
  adapter.ts     OpencodeAdapter implements AgentAdapter
  jsonl.ts       OpencodeJsonlTranslator (NDJSON event → AgentEvent)
  argv.ts        buildOpencodeArgs (arg construction + permission mapping)
```

### Type & config extensions

`src/config/profile-schema.ts`:
```ts
export type AgentKind = 'claude' | 'codex' | 'opencode';

export interface OpencodeConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  /** Per-profile isolated OpenCode config dir (OPENCODE_CONFIG_DIR).
   *  Default: <profileDir>/opencode-config. Like Codex's codex-home. */
  inheritConfig?: boolean;
  ignoreUserConfig?: boolean;
}

// ProfileConfig gains:
opencode?: OpencodeConfig;
```
`normalizeProfileConfig`: `agentKind` validation becomes three-way; `agentKind === 'opencode'` requires `opencode` block.

`src/agent/capability.ts`:
```ts
export type AgentCapabilityId = 'claude' | 'codex' | 'opencode';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'opencode-session';

export function opencodeCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'opencode',
    sessionKind: 'opencode-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    permissions: { maxAccess: profile.permissions.maxAccess ?? 'full' },
  };
}
```

### Adapter

`src/agent/opencode/argv.ts` — `buildOpencodeArgs(input)`:
- Always: `run`, `--dir <cwd>`, `--format json`.
- Access mapping:
  - `read-only` → `--agent plan` (no `--auto`).
  - `full`/`workspace` → `--agent build --auto`.
- `--session <id>` when `sessionId` present.
- `--model <provider/model>` when `model` present.
- Final positional arg = concatenated prompt string (system prompt + user message).

`src/agent/opencode/jsonl.ts` — `OpencodeJsonlTranslator` (modeled on `CodexJsonlTranslator`):

| OpenCode event (JSON mode) | AgentEvent |
|---|---|
| envelope with `sessionID` (first seen) | `{ type: 'system', sessionId }` |
| `text` event | buffered as `final_text` via `pendingAgentMessage` pattern |
| `reasoning` event | `{ type: 'thinking', delta }` |
| `tool_use` event (state `completed`) | `{ type: 'tool_use', id, name, input }` then `{ type: 'tool_result', id, output, isError }` (isError from error state) |
| `error` event | non-terminal; recorded in `lastNonTerminalError` |
| stdout EOF without terminal event | `finish()` fallback: `done` if exit 0, else `error`/`fail` (see §Error Handling) |

State machine reused from Codex translator: `terminalEmitted()`, `pendingAgentMessage` buffering, `prependPendingText()`, `finish(reason)` / `fail(message)` fallbacks, `drift` counters (`unknownEvents`/`anomalies`) with `log.warn('jsonl', 'unknown_event', ...)` on unknown types.

`src/agent/opencode/adapter.ts` — `OpencodeAdapter` (modeled on `CodexAdapter`):
- `id = 'opencode'`, `displayName = 'OpenCode'`.
- `checkAvailability()` → `checkAgentAvailability({ agentId: 'opencode', agentName: 'OpenCode', command, binaryPath })`.
- `prepareRun()` — availability check, throw `SpawnFailed` with diagnostic code on failure.
- `run(opts)`:
  - Build args via `buildOpencodeArgs`.
  - `spawnProcess(binary, args, { cwd, env: mergeProcessEnv(process.env, envOverrides), stdio: ['pipe','pipe','pipe'] })`.
  - `envOverrides` = `buildLarkChannelEnv(this.larkChannel)` + `OPENCODE_CONFIG_DIR` = `<profileDir>/opencode-config` (unless `inheritConfig`).
  - Write concatenated prompt to `child.stdin.end(...)`.
  - stderr: line-buffered `log.warn('agent', 'stderr', ...)` + Windows command-not-found detection.
  - `createEventStream`: readline over stdout NDJSON → feed translator → yield `AgentEvent`s.
- `stop()`: SIGTERM → wait `stopGraceMs` (default 5000) → SIGKILL. Sets `stopReason = 'interrupted'`.
- `waitForExit(timeoutMs)`: same as Codex.

`src/agent/index.ts`: export `OpencodeAdapter`.

### Runtime wiring

`src/runtime/agent-runtime.ts` `createRuntimeAgent` — add branch:
```ts
if (profileConfig.agentKind === 'opencode') {
  const oc = profileConfig.opencode;
  if (!oc?.binaryPath) throw new Error('opencode profile requires opencode.binaryPath');
  return new OpencodeAdapter({
    binary: oc.binaryPath,
    profileStateDir: appPaths.profileDir,
    ...(oc.inheritConfig ? { inheritConfig: oc.inheritConfig } : {}),
    ...(oc.ignoreUserConfig ? { ignoreUserConfig: oc.ignoreUserConfig } : {}),
    larkChannel,
  });
}
```

Capability selection (two existing two-way branches become three-way):
- `src/bot/channel.ts:859`
- `src/commands/index.ts:1119`

### Models (dynamic)

`src/agent/models.ts`:
- `fetchOpencodeModels(binaryPath): Promise<ModelOption[]>` — runs `opencode models`, parses output, returns `{ value: 'provider/model', label }` options. On any failure returns `[]` and `log.warn`.
- Model picker render sites (`src/commands/index.ts:1730` vicinity) call this async before rendering options; on empty result, render only `DEFAULT_MODEL`.
- `normalizeModelSelection('opencode', value)` / `resolveModelArg('opencode', value)` / `modelLabel('opencode', value)`: opencode model values are free-form `provider/model`, so validation is "non-default is accepted" (no fixed allowlist).

### Session catalog

`src/session/catalog.ts` — OpenCode entries use `sessionId` (same shape as Claude). Update three sites:
- `isValidAgentEntry`: opencode → `Boolean(sessionId) && !threadId` (same as claude branch).
- `assertAgentIdentity`: opencode → requires sessionId, must not include threadId.
- `normalizeEntry`: accept `agentId === 'opencode'`.

### Branch-site updates (~20 sites)

Sites currently checking `agentKind === 'codex'` / `agentId === 'claude'` that need OpenCode handling. OpenCode follows the **Claude-style (sessionId) path**, not the Codex-style (threadId) path:

- **Resume-from-catalog / record session** (`src/bot/run-flow.ts:123-129, 131, 191, 203`; `src/bot/comments.ts:246, 250, 331`): the `agentId === 'claude'` (resume sessionId) branches extend to also match opencode.
- **Session catalog identity** (`src/bot/session-catalog-identity.ts:25`; `src/commands/index.ts:607, 628, 638, 691-692`): opencode treated as sessionId-holding.
- **Other two-way `agentKind === 'codex'` branches** (`src/bot/channel.ts:1069, 1083, 1130, 1142, 1170`; `src/commands/index.ts:549, 645, 754, 804`): audit each; opencode defaults to the non-codex path unless the branch is codex-specific behavior (e.g. codex thread-history formatting) — those stay codex-only.
- **profile-runtime.ts** (`:90, :285, :296, :302, :398, :616`): opencode takes the non-codex path; `:616` displayName map adds opencode → `'OpenCode'`.
- **Daemon service labels** (`src/cli/commands/service.ts:586`): add opencode branch.
- **Locks/registry validation** (`src/runtime/locks.ts:181`; `src/runtime/registry.ts:67`): three-way agentKind check.
- **UI/onboard** (`src/ui/qr-register.ts:155`; `src/ui/onboard.ts:80`): three-way; add opencode option.
- **Migrate** (`src/cli/commands/migrate.ts:46`; `src/config/migrate-v2.ts:131, 203`): `agentKindFromString` accepts `'opencode'`; legacy v1 migration unaffected (opencode is new).
- **Preflight** (`src/agent/preflight.ts:282`): `LocalAgentId` + `isAgentPreflightDiagnostic` accept `'opencode'`.
- **Agent detection** (`src/cli/agent-detection.ts`): `detectInstalledAgents` adds `{ kind: 'opencode', command: process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode' }`.
- **Profile bootstrap** (`src/cli/profile-bootstrap.ts`): `createBootstrapOpencodeConfig(binaryPath)` modeled on `createBootstrapCodexConfig`; `createBootstrapProfileConfig` calls it when `agentKind === 'opencode'`; creates `<profileDir>/opencode-config` dir when `inheritConfig === false`.

## Error Handling & Edge Cases

- **Protocol drift:** unknown OpenCode event types counted (`drift.unknownEvents++`) and `log.warn`'d, not fatal — stream continues.
- **Termination semantics:**
  - In `--format json` mode there is no standalone "done" event; the CLI breaks its subscribe loop on `session.status idle` and then exits. The translator therefore treats **stdout EOF** as the terminal boundary.
  - On EOF: if exit code is 0 (or null) and no error recorded → `finish('normal')` emits `done`; if an `error` event was recorded → `fail()` with that message; if non-zero exit and no terminal event → `fail('opencode exited with code N: <stderr excerpt>')`.
  - `error` event itself is non-terminal (recorded in `lastNonTerminalError`); it does not end the stream.
- **Spawn failure / no stdout:** `silentExitTimer` destroys stdout after 50ms if nothing emitted (same as Codex); Windows command-not-found stderr line detection reuses `isWindowsCommandNotFoundLine`.
- **Model fetch failure:** `opencode models` failure → picker falls back to `DEFAULT_MODEL` only + `log.warn`; never blocks `/config`.
- **Permission limitation:** `full` and `workspace` behave identically on the OpenCode side. Documented in `/status` output and README so users don't expect an intermediate access tier.
- **Windows argv safety:** prompt goes through stdin (not argv) to avoid `cmd.exe` interpreting `<`/`>` in the prompt's `<bridge_context>` XML — same constraint that drove the Codex adapter's design.

## Testing

Mirrors the Codex test matrix:

- `tests/unit/agent/opencode-jsonl.test.ts` — translator: each event type → AgentEvent, terminal/non-terminal, drift counting, buffering.
- `tests/unit/agent/opencode-argv.test.ts` — arg construction + three-layer permission mapping + session/model inclusion.
- `tests/process/opencode-adapter.test.ts` — end-to-end via `tests/helpers/fake-executable.ts` spawning a fake `opencode` binary that emits canned NDJSON; verifies the full `AgentEvent` stream, stop/SIGTERM, and exit-code paths.
- `tests/unit/config/profile-schema.test.ts` — opencode profile serialization/validation (requires `opencode` block, three-way agentKind).
- `tests/static/contracts.test.ts` + `tests/unit/docs/readme-contract.test.ts` — update if they assert the agent-kind set / CLI registration / README mentions.
- `tests/unit/cli/start-agent-factory.test.ts` — add opencode to the agent factory coverage.

## Documentation

README: new OpenCode section (install `opencode-ai`, `--agent opencode` profile creation, permission-mode mapping table including the `full`≡`workspace` note, dynamic model picker behavior).

## Out of Scope (YAGNI)

- `opencode serve` / `--attach` server mode (direct mode only for v1).
- `--variant` (reasoning effort) wiring in v1 (model only).
- `--share` / `--fork` / `--title` flags.
- Image attachment via `--file` in v1 (the existing attachment pipeline can be wired later if needed; `supportsNativeHistory` and the attachment policy still apply).
- Renaming `claude-session`/`codex-thread` to generic names (keep focused).
