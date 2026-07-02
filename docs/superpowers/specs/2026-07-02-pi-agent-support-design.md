# Design: Support `pi` as a third agent kind

Date: 2026-07-02

## Goal

`lark-channel-bridge` currently bridges Feishu/Lark to two local coding agent CLIs: Claude Code (`claude`) and Codex CLI (`codex`), selected per-profile via `agentKind`. Add a third: **pi** (`@earendil-works/pi-coding-agent`, binary `pi`, https://pi.dev), following the same profile/adapter model. Codex is the closer precedent throughout (it was added more recently and its extension points — pinned binary config, profile-scoped home directory — are the most complete), so this design mirrors Codex wherever the two agents are similar and calls out where pi differs.

## Adapter architecture

**Spawn-per-turn**, matching the existing `AgentRun` model used by Claude and Codex — not a long-lived `pi --mode rpc` process. Each turn:

```
pi --mode json --session <id>?   [--tools read,grep,find,ls]?   [@<imagePath> ...]
```

- `--mode json`: pi's single-shot, non-interactive event-stream mode (`src/modes/print-mode.ts` in pi-mono — confirmed single prompt in, JSON events out, process exits). This is pi's direct analog of Claude's `-p --output-format stream-json` and Codex's `exec --json`.
- Session continuity: pi's `--session <path|id>` natively resumes full history (like Claude's `--resume`, unlike Codex's thread model). The first line of JSON-mode output is always a session header `{"type":"session","id":"<uuid>",...}`; the adapter captures that id and the bridge's session catalog stores it under a new `sessionKind: 'pi-session'`.
- Prompt delivery: **entirely via stdin**, no positional message argument. pi's CLI merges piped stdin content into the initial message even when no trailing message argument is given (confirmed via `src/cli/initial-message.ts` in pi-mono: `stdinContent` alone becomes `initialMessage` when `parsed.messages` is empty). This reuses the existing `prefixBridgeSystemPrompt` stdin-prefix technique already built for Codex — no new file-based system-prompt mechanism, and it sidesteps the Windows argv/cmd.exe-escaping bug that previously bit the Claude adapter (see `src/agent/claude/adapter.ts` comment), since the prompt text never touches argv.
- Images: passed as `@<absolute-path>` positional argv tokens (pi's CLI file-inclusion syntax), one per accepted image attachment — the same shape as Codex's `--image <path>` flags, and equally low-risk on argv since the paths come from the bridge's own media cache, never from user-controlled text.
- No `--model` / `--provider` flags (see Model selection below).

### New files (mirroring `src/agent/codex/`)

- `src/agent/pi/argv.ts` — `buildPiArgs({ cwd, accessMode, sessionId, images })`, pure function returning the args array above. Throws on unrecognized `accessMode`, mirroring `buildCodexArgs`'s sandbox validation.
- `src/agent/pi/jsonl.ts` — `PiJsonlTranslator`, converts pi's `AgentSessionEvent` stream (session header, `message_update`/`assistantMessageEvent` deltas, `tool_execution_start/end`, `agent_end`) into the bridge's common `AgentEvent`:
  - session header → `{type:'system', sessionId}`
  - `assistantMessageEvent.type === 'text_delta'` → `{type:'text', delta}`
  - `assistantMessageEvent.type === 'thinking_delta'` → `{type:'thinking', delta}`
  - `tool_execution_start` → `{type:'tool_use', id: toolCallId, name: toolName, input: args}`
  - `tool_execution_end` → `{type:'tool_result', id: toolCallId, output, isError}`
  - assistant message `usage` (input/output/cacheRead/cacheWrite/cost) on `message_end` → `{type:'usage', ...}`
  - `agent_end` → `{type:'done', sessionId, terminationReason:'normal'}`
  - `assistantMessageEvent.type === 'error'`, non-zero exit, or spawn failure → `{type:'error', ...}`, following the same early-exit/stderr-capture/`terminalEmitted()` guard pattern as `CodexJsonlTranslator`.
- `src/agent/pi/adapter.ts` — `PiAdapter implements AgentAdapter`, structurally near-identical to `CodexAdapter`: `spawnProcess`, write `prefixBridgeSystemPrompt(opts.prompt, botIdentity)` to stdin then `.end()`, stream stdout via `createInterface`, SIGTERM→grace→SIGKILL `stop()`, `waitForExit()`.

### Existing files to touch

- `src/agent/index.ts` — export `PiAdapter`.
- `src/agent/capability.ts` — `AgentCapabilityId`/`AgentSessionKind` gain `'pi'`/`'pi-session'`; add `piCapability(profile)`:
  ```ts
  {
    agentId: 'pi',
    sessionKind: 'pi-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
    permissions: { maxAccess: profile.permissions.maxAccess },
  }
  ```
- `src/bot/run-flow.ts` — extend the `images` condition (currently `capability.agentId === 'codex'`) to include `'pi'`; extend the session-catalog resume branch (currently `if (catalogEntry?.agentId === 'claude') ... else if (catalogEntry?.agentId === 'codex')`) with a `'pi'` branch using `sessionId`/`resumeFrom` like Claude (native history).

## Permission mapping

pi has no built-in graduated sandbox — by default it runs with the full permissions of the launching process/user (per pi's own docs: containerize it yourself for stronger isolation). Rather than inventing a pi-specific 3-value sandbox enum (like `CodexSandboxMode`/`ClaudePermissionMode`), thread the bridge's own `AccessMode` straight through, since pi's actual mapping is exactly the bridge's native 2-tier distinction (tool-restricted vs unrestricted):

- Add `accessMode?: AccessMode` to `AgentRunOptions` (`src/agent/types.ts`). `RunPolicyAllow` already computes `accessMode` (`src/policy/run-policy.ts`); `run-executor.ts` just needs to forward it alongside the existing `sandbox`/`permissionMode` fields (all three always populated; each adapter reads only the one it needs — same pattern as today).
- `buildPiArgs` maps:
  - `read-only` → `--tools read,grep,find,ls` (drops `bash`/`edit`/`write`)
  - `workspace` and `full` → no `--tools` flag (pi's unrestricted default)
- Document this gap explicitly in README: pi's `workspace` access level currently behaves identically to `full`; users wanting filesystem/network confinement must containerize pi themselves (per pi's own containerization docs).

## Binary resolution & profile isolation

Follow the Codex precedent exactly (not the simpler Claude PATH-only lookup), since pi is a third-party CLI evolving outside this repo and the user is actively developing it locally (`~/monorepo/pi-mono`) — pinning guards against silently picking up an unexpected build.

`src/config/profile-schema.ts`:
```ts
export type AgentKind = 'claude' | 'codex' | 'pi';

export interface PiConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  piHome?: string;
  inheritPiHome?: boolean; // default false: profile-scoped pi-home dir
}
```
`ProfileConfig.pi?: PiConfig`, alongside the existing `codex?: CodexConfig`, validated the same way (`agentKind === 'pi' && !raw.pi` guard, etc.).

Profile isolation: default to a profile-scoped `PI_CODING_AGENT_DIR` (`~/.lark-channel/profiles/<profile>/pi-home`), mirroring `CODEX_HOME`/`inheritCodexHome`. `inheritPiHome: true` opts a profile back into pi's global `~/.pi/agent` (shared login/sessions/extensions across profiles) — same escape hatch Codex offers.

`src/cli/profile-bootstrap.ts`: add `createBootstrapPiConfig(binaryPath?)` mirroring `createBootstrapCodexConfig` (resolve executable, `realpath`, record), wired into `createProfileConfig` when `agentKind === 'pi'`; `mkdir` the profile's `pi-home` dir when `!inheritPiHome`.

`src/agent/preflight.ts`: `LocalAgentId` gains `'pi'`; `isAgentPreflightDiagnostic` accepts `'pi'`.

`src/cli/agent-detection.ts`: add `{ kind: 'pi', command: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' }` to `detectInstalledAgents()`; `AgentKind` union gains `'pi'`.

## Model selection

Not exposed in `/config` for v1. No `--model`/`--provider` flags are passed to `pi`; it uses its own already-configured default (last-used model / logged-in provider). `src/agent/models.ts`'s `supportedModels('pi')` returns a single `[DEFAULT_MODEL]` option, so the `/config` model picker degrades to "跟随默认" only rather than a hardcoded list — pi's model space spans multiple providers and curating it now would be premature. Revisit once there's a concrete need.

## CLI wizard & docs

- First-run QR wizard's "choose which agent to initialize" step gains a `pi` option.
- Every remaining `agentKind === 'codex' ? ... : ...` binary/config branch (in `src/cli/index.ts`, `src/cli/commands/{start,service,migrate}.ts`, `src/commands/index.ts`, `src/config/migrate-v2.ts`, `src/config/profile-store.ts`, `src/runtime/profile-runtime.ts`, `src/session/catalog.ts`, `src/bot/session-catalog-identity.ts`) becomes a 3-way switch/lookup keyed by `AgentKind`. Exact call sites to be enumerated with a codebase search during implementation.
- `README.md` / `README.zh.md`: add `pi` to prerequisites (link to pi.dev), the profile example table (`lark-channel-bridge start --profile pi --agent pi`), and the permission-mode mapping table (new "Pi mode" column: `full`/`workspace` → no restriction, `read-only` → `--tools read,grep,find,ls`), plus the workspace-sandbox-gap note from the Permission mapping section above. Check `tests/unit/docs/readme-contract.test.ts` — README content may be contract-tested against code, so table edits must stay in sync with whatever that test asserts.

## Automated testing

Mirror the existing Codex test surface:

- **`tests/unit`**: `buildPiArgs` (read-only vs workspace/full, with/without session id, with/without images), `PiJsonlTranslator` (every event type → `AgentEvent`, including error/abort paths), `AgentRunOptions.accessMode` passthrough in `run-executor`, `PiConfig` validation in `profile-schema`.
- **`tests/process`**: a `pi`-adapter process-level test analogous to `tests/process/codex-adapter.test.ts` — spawn a fake `pi` script emitting canned JSON-mode output, assert translated events plus `stop()`/`waitForExit()` behavior.
- **`tests/integration`**: profile bootstrap with `agentKind: 'pi'`, `/status` and `/config` rendering for a pi profile, wizard agent-selection covering pi.

## Manual end-to-end verification (post-implementation, not automated)

Requires a real Feishu/Lark app and a logged-in local `pi` CLI, so this runs manually once the code is done — not part of `pnpm test`:

1. `lark-channel-bridge profile create pi-test --agent pi`
2. `lark-channel-bridge run --profile pi-test` (foreground)
3. From `lark-cli`, authenticated as a real user account (not the bot), send a DM to the bot
4. Confirm: the bridge spawns `pi`, streams back a reply (and a COT process message if enabled), `/status` shows the pi session as active
5. Exercise one interrupt path (`/stop` mid-run) and one session-continuity path (`/new`, then a follow-up message resumes correctly via `--session`)
