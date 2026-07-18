# Devin CLI Integration — Phase A (Path A: `devin -p`)

## Status

Phase A is **complete and verified**. The Devin CLI is now a first-class agent
kind in the bridge, alongside Claude Code and Codex CLI.

## What was done

A new `DevinAdapter` wraps `devin -p --prompt-file <tmp> --permission-mode
dangerous` and streams stdout as `text` deltas, then emits `final_text` +
`done`. This is the simplest possible integration — no structured tool events,
no session resume, no image input.

### Files changed

- **New:** `src/agent/devin/adapter.ts` — the `DevinAdapter` class
- `src/agent/index.ts` — re-export `DevinAdapter`
- `src/agent/capability.ts` — added `'devin'` to `AgentCapabilityId`,
  `AgentSessionKind`; added `devinCapability()` and `capabilityForProfile()`
  helper (centralizes the claude/codex/devin switch)
- `src/agent/models.ts` — added `DEVIN_MODELS` list; `supportedModels('devin')`
- `src/agent/preflight.ts` — `'devin'` added to `LocalAgentId` and
  `isAgentPreflightDiagnostic`
- `src/config/profile-schema.ts` — `AgentKind` union includes `'devin'`;
  `normalizeProfileConfig` accepts it
- `src/config/profile-store.ts` — `agentKindFromString('devin')` returns
  `'devin'`
- `src/config/migrate-v2.ts` — migration accepts devin agentKind from registry
- `src/cli/agent-detection.ts` — `detectInstalledAgents()` probes for `devin`
  binary (via `LARK_CHANNEL_DEVIN_BIN` env or PATH)
- `src/cli/commands/start.ts` — `createRuntimeAgent()` instantiates
  `DevinAdapter` for `agentKind === 'devin'`; `checkRuntimeAgentAvailability`
  maps `agent.id === 'devin'`
- `src/cli/commands/service.ts` — `agentDisplay('devin')` → "Devin CLI"
- `src/cli/index.ts` — all `--agent` help text updated to include `devin`
- `src/runtime/profile-runtime.ts` — `resolveBootstrapAgent`, `displayAgentKind`,
  error messages, and "no agent found" message all include devin
- `src/runtime/registry.ts` — `isValidEntry` accepts `agentKind === 'devin'`
- `src/runtime/locks.ts` — `isRuntimeLockMeta` accepts `agentKind === 'devin'`
- `src/session/catalog.ts` — `normalizeEntry` accepts `agentId === 'devin'`
- `src/bot/channel.ts`, `src/bot/comments.ts`,
  `src/bot/session-catalog-identity.ts`, `src/commands/index.ts` — replaced
  the `agentKind === 'codex' ? codexCapability : claudeCapability` ternary
  with `capabilityForProfile()` (handles all three agent kinds)
- `src/commands/index.ts` — `/resume` and `applyResume` return a friendly
  "not supported in Phase A" message for devin profiles
- `tests/unit/runtime/profile-runtime.test.ts` — updated expected error
  message to include `devin`

### Verification

- `pnpm typecheck` — passes (0 errors)
- `pnpm build` — passes (tsup builds `dist/cli.js` and `dist/index.js`)
- `pnpm test` — 553 pass, 3 fail (all 3 are pre-existing Windows `sh` stub
  failures in `start-codex-legacy-config.test.ts`, unrelated to this change)
- Smoke test: `DevinAdapter` spawned `devin -p`, streamed "pong" as text
  delta, emitted `final_text` + `done: normal` — PASS

## How to use

```bash
# Create a devin profile (requires valid Lark app credentials)
lark-channel-bridge profile create my-devin --agent devin \
  --app-id <your-app-id> --app-secret <your-app-secret> --tenant feishu

# Start the bridge with the devin profile
lark-channel-bridge run --profile my-devin
```

Or let the bridge auto-detect devin on first run if it's the only agent
installed:

```bash
lark-channel-bridge run --agent devin
```

### Environment variables

- `LARK_CHANNEL_DEVIN_BIN` — override the devin binary path (default: `devin`
  from PATH)

## Phase A limitations (by design)

1. **No structured tool events.** `devin -p` outputs plain text only — no
   `--output-format stream-json` equivalent. Tool calls happen inside the
   agent and surface only as part of the final text. The Lark card will show
   the answer but no tool-call chips.
2. **No session resume.** The bridge's run-flow only sets `sessionId` for
   `agentId === 'claude'`. Devin's `--resume <session-id>` is not wired.
   `/resume` returns a "not supported" message.
3. **No image input.** `devin -p` has no stdin image protocol.
4. **`--permission-mode dangerous` is hardcoded** so non-interactive runs
   never block on an approval prompt. Phase B should map this from
   `profileConfig.permissions`.

## Phase B upgrade plan (ACP client)

Phase B will replace the `devin -p` wrapper with an ACP (Agent Client
Protocol) client that talks to `devin acp` over stdio JSON-RPC. This unlocks:

1. **Structured streaming events.** ACP provides `task/artifact` and
   `task/state` notifications that can be mapped to the bridge's
   `tool_use` / `tool_result` / `text` / `final_text` events, enabling
   tool-call chips in the Lark card.
2. **Session resume.** ACP sessions can be resumed by session ID, enabling
   `/resume` support for devin profiles.
3. **Permission mapping.** ACP's `permission/policy` can be set from
   `profileConfig.permissions` instead of hardcoding `dangerous`.
4. **Image input.** ACP's `task/new` accepts multipart messages with images.

### Phase B implementation sketch

- New file: `src/agent/devin/acp-adapter.ts` — implements `AgentAdapter`
  using a JSON-RPC client over stdio (spawn `devin acp`, speak ACP)
- `createRuntimeAgent()` in `start.ts` switches to `DevinAcpAdapter` when
  a feature flag (e.g. `profileConfig.devin?.protocol === 'acp'`) is set
- `devinCapability()` updated: `supportsNativeHistory: true`,
  `sessionKind: 'devin-session'` (already set)
- Map ACP events → `AgentEvent`:
  - `task/artifact` (text parts) → `text` delta + `final_text`
  - `task/artifact` (tool parts) → `tool_use` + `tool_result`
  - `task/state` (completed/failed) → `done` / `error`
- Wire `opts.sessionId` → ACP `task/resume` with the session ID
- Add `src/config/profile-schema.ts` `DevinConfig` section (binary path,
  protocol selection, permission mode mapping)
