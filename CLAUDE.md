# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lark-channel-bridge` is a Node.js (ESM, TypeScript) bot that bridges **Feishu / Lark messenger with local Claude Code or Codex CLI agents**. A Feishu message (DM, `@bot` in a group, or a cloud-doc comment mention) becomes a local agent run; the agent's streaming reply (text + tool calls) renders back as an interactive Lark card. One installation can host multiple **profiles**, each bound to its own Feishu PersonalAgent app and its own agent kind (Claude or Codex), running side-by-side as machine-managed background services.

Node **>= 20.12.0**, package manager **pnpm@10.33.0**.

## Commands

```bash
pnpm install --frozen-lockfile      # install (CI uses frozen lockfile)
pnpm dev                            # tsup --watch (CLI build only, no web console)
pnpm build:web                      # vite build the React console into src/ui/generated/index.html
pnpm build                          # build:web + tsup (entry: src/cli/index.ts -> dist/cli.js)
pnpm typecheck                      # tsc --noEmit (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
pnpm test                           # vitest run — runs pretest (build:web) first, then unit+integration+process
pnpm test:unit                      # vitest run tests/unit
pnpm test:integration               # vitest run tests/integration
pnpm test:process                   # vitest run tests/process  (spawns real claude/codex binaries)
pnpm test unit/bot/cot              # run a single test file by path (omit the leading tests/)
pnpm ci:local                      # git diff --check && test && typecheck && build
```

Notes a contributor needs:
- **`pnpm test` always rebuilds the web console first** (`pretest` → `build:web`). The console HTML is inlined into the CLI bundle via a `.html` text-loader (see `tsup.config.ts` and the matching `html-string-loader` plugin in `vitest.config.ts`). Tests import `src/ui/generated/index.html` as a string; if you skip `build:web`, tests that touch the UI server fail.
- The **`@/*` path alias** maps to `src/*` (see `tsconfig.json` `paths`) — though the codebase mostly uses relative imports.
- `tests/process/*` actually spawn the real `claude`/`codex` binaries via `tests/helpers/fake-executable.ts` and `tests/helpers/fake-agent.ts`; unit/integration tests use the fake agent/channel helpers in `tests/helpers/`.

## Runtime entry & CLI surface

CLI entry is `src/cli/index.ts` (commander). Binary shim `bin/lark-channel-bridge.mjs` just imports `dist/cli.js`. Each command's implementation lives in `src/cli/commands/` (`start.ts`, `migrate.ts`, `profile.ts`, `ps.ts`, `secrets.ts`, `service.ts`, `ui.ts`).

Commands:
- `run` — foreground single-profile bridge; opens the QR/onboard wizard on first run. Use for setup and debugging. (In older versions this was `start`.) `--web-ui` runs the machine-wide **supervisor** + local web console (hosts all profiles) instead of a single headless profile.
- `start` / `stop` / `restart` / `status` / `unregister` — install/manage an OS-managed background service per profile (launchd / systemd / Task Scheduler, see `src/daemon/`). **Install globally before using these** — the daemon records the bridge CLI path, and an `npx` temp-cache path breaks when the cache is cleared.
- `profile create/list/use/remove/export` — manage profiles. `remove` archives by default (switches to next profile, or clears root config if last); `--purge --yes` permanently deletes; `export` redacts secrets unless `--include-secrets --yes`.
- `ps` / `kill <id|#>` — list/terminate running bridge processes (operates on the local process registry).
- `migrate` — migrate legacy v1 config/state into the v2 profile layout (`src/config/migrate-v2.ts`).
- `secrets set/list/get/remove` — manage profile-local encrypted secrets.

## Architecture

### The core message → run → reply flow

The load-bearing path is:

```
Lark WebSocket event (@larksuite/channel)
  └─ src/bot/channel.ts   startChannel()
       ├─ normalizes message → ScopeContext (im | card | comment)
       ├─ src/policy/access.ts          canUseDm/canUseGroup/requireMention  (fail-closed allowlist)
       ├─ src/policy/run-policy.ts      evaluateRunPolicy() — scope → session/cwd resolution + attachments
       ├─ src/policy/workspace.ts        resolveWorkingDirectory()
       ├─ src/bot/run-flow.ts            startRunFlow() — resolves session catalog + workspace, then submits
       └─ src/runtime/run-executor.ts    RunExecutor.submit() → ProcessPool.acquire() → AgentAdapter.run()
            └─ adapter streams AgentEvent[] (text/tool_use/tool_result/usage/done/error)
                 └─ src/card/run-state.ts  reduce() folds events into RunState
                      └─ src/card/run-renderer.ts renderCard() / text-renderer.ts renderText()
                           └─ streamed back to Lark as an interactive card (or markdown/text)
```

`AgentEvent` (`src/agent/types.ts`) is the single shared stream contract every adapter emits; `RunState` (`src/card/run-state.ts`) is the reducer state the card renderer consumes. Both adapters (`src/agent/claude/adapter.ts`, `src/agent/codex/adapter.ts`) implement the same `AgentAdapter` interface. Adding a new agent means a new adapter + an entry in `createRuntimeAgent` (`src/runtime/agent-runtime.ts`).

### Concurrency, queueing, and interrupts

- **`ProcessPool`** (`src/bot/process-pool.ts`) — FIFO concurrency cap for agent runs. The cap is re-read fresh on every `acquire()`, so `/config maxConcurrentRuns` takes effect for the next run (prevents one busy topic group from spawning dozens of `claude` subprocesses and drowning Anthropic rate limits).
- **`PendingQueue`** (`src/bot/pending-queue.ts`) — messages arriving during an active run are debounced (`DEBOUNCE_MS = 600` in `channel.ts`) and batched into the next turn.
- **`ActiveRuns`** (`src/bot/active-runs.ts`) — tracks live runs so `/stop` and the card's ⏹ button can interrupt. Interrupting commands (`/new`, `/cd`, `/ws use`, `/stop`) cancel the current run.
- **Idle watchdog** — `/timeout [N|off|default]` kills a run that emits nothing for N minutes (`getRunIdleTimeoutMs`).

### Profiles, config layering, and on-disk state

Config is **two layers**: a root `config.json` listing profiles + active profile, and per-profile state directories.

- `src/config/schema.ts` — `AppConfig` (root), `MessageReplyMode` (`card` | `markdown` | `text`), `CotMessagesMode`, `SecretRef`/`SecretInput`, access config. `get*` helpers here read effective values.
- `src/config/profile-schema.ts` — `ProfileConfig`, `AgentKind` (`claude` | `codex`), `ProfileMode` (`personal` | `team`), `LarkCliConfig` identity preset. `effectiveLarkCliIdentity()` resolves the active preset.
- `src/config/app-paths.ts` — **the single source of truth for all on-disk paths** (`resolveAppPaths`). Root is `LARK_CHANNEL_HOME` (default `~/.lark-channel`). All per-profile dirs derive from `rootDir/profiles/<profile>/`.

On-disk layout (from `app-paths.ts`, mirrors README "Data directories"):

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Root config: profiles + active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<p>/sessions.json` + `.catalog.json` | Session state + agent-aware catalog |
| `~/.lark-channel/profiles/<p>/workspaces.json` | Current + named workspace bindings |
| `~/.lark-channel/profiles/<p>/secrets.enc` (+ `.keystore.salt`) | Profile-local **encrypted** secrets |
| `~/.lark-channel/profiles/<p>/lark-cli/` | Per-profile lark-cli config dir (isolates auth per profile) |
| `~/.lark-channel/profiles/<p>/media/`, `logs/` | Attachment cache, structured run logs |
| `~/.lark-channel/registry/processes.json` + `registry/locks/` | Local process registry + profile/app locks |

`LARK_CHANNEL_HOME` moves all state; `LARK_CHANNEL_LOG_DAYS` overrides log retention.

### Secrets

Secrets never live in `config.json` as plaintext. A `SecretRef` (`schema.ts`) points at `env` / `file` / `exec` providers resolved by `src/config/secret-resolver.ts`. Secrets destined for the agent subprocess go through the encrypted keystore (`src/config/keystore.ts`, `secrets.enc`) and a `secrets-getter` script. `profile export` redacts secrets by default.

### Sessions & continuity

Each chat/topic/doc-comment-thread keeps its own session. The **scope** string (`src/policy/run-policy.ts` `ScopeContext`, set in `src/commands/index.ts` `CommandContext.scope`) is the key: p2p/regular group = `chatId`; topic group = `${chatId}:${threadId}`; doc comment = comment scope. All session/workspace/active-run reads/writes go through `scope`, **never raw `msg.chatId`**.

- `src/session/store.ts` — session state per scope.
- `src/session/catalog.ts` — agent-aware catalog mapping bridge session → agent session/resume token (different shapes for Claude `--resume` vs Codex `--last-message-id`). `src/session/codex-history.ts` reads Codex thread history; `src/session/history.ts` formats recent sessions for `/status`/`/resume`.

A gotcha in topic groups: Feishu omits `thread_id` from many topic event payloads, so `src/bot/thread-id.ts` `lookupMessageThreadId()` recovers it via raw `im.v1.message.get`. Without it, replies escape into a new topic and the scope collapses to chat level.

### lark-cli integration & identity policy

The bridge spawns `lark-cli` (a separate Go binary) as a subprocess of the agent so the agent can call Feishu OpenAPI. Each profile gets an isolated lark-cli dir (`~/.lark-channel/profiles/<p>/lark-cli/`) injected via `LARKSUITE_CLI_CONFIG_DIR` — **personal authorization in one profile is not shared with another**.

- `src/lark-cli/identity-policy.ts` — `bot-only` (default; app identity only, no personal resources) vs `user-default` (app + authorized user identity). `team` mode forces `bot-only`.
- `src/lark-cli/profile-projection.ts` — projects the profile config into the lark-cli dir.
- `src/agent/lark-channel-env.ts` — builds the `LARK_CHANNEL=1` env injected into agent subprocesses so they enter "bridge-bound" mode.

### Supervisor & background services

`src/runtime/supervisor.ts` is the multi-profile host (used by `run --web-ui` and by the daemons). It owns one `ProfileRuntime` (`src/runtime/profile-runtime.ts`) per profile, each with its own locks, registry entry, stores, channel, and `Controls`. `stop()` tears down only that profile — **no `process.exit`** — so the supervisor keeps hosting the others.

- `src/runtime/registry.ts` — `processes.json` registry; tracks running `start` processes for duplicate-app warnings and `ps`/`kill`. Single-machine only.
- `src/runtime/locks.ts` + `host-lock.ts` — profile locks, app locks, and a machine-wide supervisor lock (only one supervisor runs). `src/platform/atomic-write.ts` for crash-safe config writes.
- `src/daemon/` — `service-adapter.ts` dispatches to `launchd.ts` (macOS), `systemd.ts` (Linux), `schtasks.ts` (Windows). Service labels: `ai.lark-channel-bridge.bot.<profile>` / `lark-channel-bridge.bot.<profile>.service` / Task Scheduler `LarkChannelBridge.Bot.<profile>`.

### Web console (optional management UI)

`web/` is a Vite + React 19 + Tailwind 4 single-page app (`web/src/views/`: OnboardWizard, Profiles, ProfileDetail, ConfigView). `pnpm build:web` compiles it to `src/ui/generated/index.html`, which tsup **inlines as a string** into the CLI bundle. At runtime `src/ui/server.ts` serves it on `127.0.0.1` with a per-process random token gating every `/api/*` call (`src/ui/http.ts`, `src/ui/sidecar.ts`). The host-level supervisor console (`--web-ui`) can list/start/stop/configure any profile; per-profile consoles serve only that profile.

### Telemetry

The bridge ships **zero telemetry by default** — no metrics/logs leave the machine, no telemetry deps. `src/core/telemetry.ts` is a noop adapter unless `LARK_CHANNEL_TELEMETRY_MODULE` points at a package that exports an `AdapterFactory`. A bad module/adapter degrades to noop — telemetry can never block startup or logging. `src/core/logger.ts` emits structured JSONL logs (with redaction, `tests/unit/core/logger-redaction.test.ts`).

## Conventions & gotchas

- **Each profile MUST get its own adapter instance** — the adapter stores bot identity on itself (`setBotIdentity`), set late after the WS handshake. See the comment in `src/runtime/agent-runtime.ts` `createRuntimeAgent`.
- **Prompts must not go through argv.** On Windows, `claude` is a `.cmd` shim that `cross-spawn` routes through `cmd.exe`, which interprets `<`/`>` as redirection and silently eats the prompt's XML. Both adapters pass the prompt via stdin and appended system prompt via a temp file (`src/agent/claude/adapter.ts`, `src/agent/codex/adapter.ts`).
- **Agent availability / preflight.** `src/agent/preflight.ts` produces `agent-binary-not-found`-style diagnostics surfaced by `/doctor`. The default Claude permission mode is `bypassPermissions` (`CLAUDE_DEFAULT_PERMISSION_MODE`).
- **Access is fail-closed and private by default.** Empty allowlists mean nobody (only the app owner + admins bypass). The bot replies *silently* to strangers (no "permission denied", which would confirm the bot exists). Access changes apply on the next message — no restart.
- **Access modes map to agent modes** (`src/config/permissions.ts`): `full`→Claude `bypassPermissions` / Codex `danger-full-access`; `workspace`→`acceptEdits`/`workspace-write`; `read-only`→`plan`/`read-only`.
- **COT (chain-of-thought) process messages** (`src/bot/cot.ts`) are a *separate* message from the final answer. `off`/`brief`/`detailed` controls process-view verbosity. The final answer is always generated from the agent's raw text with no heuristic filtering.
- **`messageReplyMode`**: `card` (full interactive, streamed), `markdown` (lightweight streaming), `text` (sent once after run). Pre-0.1.27 `text` meant what's now `markdown` — there's auto-coercion logic (`messageReplyMigrated`).
- **Slash commands inside chat** are handled in `src/commands/index.ts` via the `Controls` interface (in-process `restart`/`exit`, owner refresh, etc.). `tryHandleCommand` runs before any agent run. The full command table (`/new`, `/cd`, `/ws`, `/resume`, `/status`, `/config`, `/invite`, `/remove`, `/stop`, `/timeout`, `/ps`, `/exit`, `/reconnect`, `/doctor`, `/help`) is in the README.
- **`ScopeContext.source`** is `im` | `card` | `comment`. Cloud-doc comment runs are document-scoped, reuse the document session key, and fall back to `$HOME` when no document cwd was recorded.
