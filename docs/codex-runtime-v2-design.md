# Codex Runtime v2 and Version Management

Status: runtime implemented; updater MVP implements manual integrity-verified check/status/apply/rollback, stable-launcher activation, and stopped-service re-registration. Manifest signing, automatic drain, and unattended scheduling remain deferred.

## Goals

- Support native `turn/steer` while a Codex turn is running.
- Make stop completion-safe: a scope cannot resume its thread until the interrupted turn is terminal and the runtime has drained it.
- Preserve existing user-owned data: Codex home, skills, plugins, credentials, workspaces, session catalog, and thread store.
- Manage compatible Bridge and CLI versions with health-checked activation and rollback.
- Prefer a coherent runtime and API over preserving the existing Agent Console API byte-for-byte.

## Current implementation facts

- `CodexAdapter` starts a new `codex exec --json` child for every message.
- `ActiveRuns.interrupt(scope)` removes the run from the active map before asynchronous shutdown finishes.
- `RunExecutor` assumes one OS process equals one run and releases the scope/process-pool slot around that lifecycle.
- Codex thread history already uses `codex app-server` and `thread/list`, so the repository has a proven spawn/environment pattern.
- Codex CLI `0.153.2` has been compatibility-tested against the long-lived App Server path. It preserves `turn/start`, `turn/steer`, `turn/interrupt`, `thread/start`, `thread/resume`, generated TypeScript protocol bindings, and terminal turn notifications; updater rollback remains compatible with protocol revisions `0.141` and `0.150`.
- The current Agent Console depends directly on `ActiveRuns` and `RunExecutor`; those dependencies must move behind a runtime coordinator.

## Architectural decisions

### 1. Keep Claude and Codex execution paths separate

Claude continues through the existing one-process-per-run `AgentAdapter` and `RunExecutor`. Codex gets a dedicated long-lived runtime. Do not distort the generic `AgentRun` interface to represent both process runs and App Server turns.

### 2. One App Server supervisor per Bridge profile

`CodexAppServerSupervisor` owns one long-running `codex app-server --listen stdio://` child, initialized with the same resolved `CODEX_HOME` and Lark environment as the current adapter. It owns:

- process start, initialize, stderr and exit handling;
- JSON-RPC request correlation and timeouts;
- server notification fan-out;
- restart with exponential backoff;
- capability/version checks;
- graceful shutdown.

The supervisor is the sole owner of the child's stdin/stdout. No scope or HTTP handler writes JSON-RPC directly.

### 3. One serialized scope actor per conversation scope

`CodexRuntimeCoordinator` maps each scope to a serialized actor. Commands for one scope cannot race; different scopes may run concurrently on the same App Server.

States:

```text
idle -> starting -> running -> idle
                    |   ^
                    v   |
                 stopping -> draining -> idle
                    |
                    v
                  failed -> reconciling -> idle
```

The runtime state is in memory and reconciled after process restart. It is not persisted as authoritative state.

### 4. Message submission chooses start versus steer atomically

`submitMessage(scope, input)` runs inside the scope actor:

- `idle`: resolve policy/workspace and thread binding, then `thread/start` or `thread/resume`, followed by `turn/start`;
- `running`: validate that cwd, access policy, model, and thread binding have not changed, then call `turn/steer`;
- `stopping`, `draining`, or `reconciling`: enqueue the message with a bounded queue and start it only after the scope is reusable;
- non-steerable Codex turns, such as review or compact: enqueue rather than silently starting a competing turn.

Each inbound message has a bridge-generated `messageId` passed as `clientUserMessageId` for idempotency and observability.

### 5. Stop is a two-stage operation

`stop(scope)` means "request accepted", not "thread is already reusable":

1. transition `running -> stopping`;
2. send `turn/interrupt(threadId, turnId)`;
3. wait for matching `turn/completed` with terminal status;
4. reconcile thread status if the notification or App Server connection is lost;
5. transition through `draining` to `idle`;
6. dispatch the oldest queued message, if any.

The scope is never removed merely because the interrupt RPC returned.

### 6. Durable and ephemeral sources of truth

| Concept | Authoritative source |
| --- | --- |
| Skills and plugins | resolved `CODEX_HOME` filesystem and Codex App Server skill/plugin APIs |
| Codex threads | Codex thread store under the resolved `CODEX_HOME` |
| Scope-to-thread binding | existing `SessionCatalog` |
| Workspace and access policy | existing workspace/profile configuration |
| Active turn and scope state | `CodexRuntimeCoordinator`, reconciled with App Server notifications |
| Installed component versions | update manager's signed/validated local manifest |

Existing user data is zero-copy. Schema additions must be backward-readable; the updater never owns or deletes profile data.

## Backend/API v2

The current API may be kept temporarily through an adapter, but v2 semantics are the source of truth:

- `POST /api/v2/scopes/:scope/messages`
- `POST /api/v2/scopes/:scope/stop`
- `POST /api/v2/scopes/:scope/new-thread`
- `GET /api/v2/scopes/:scope`
- `GET /api/v2/runtime`
- SSE event stream with `scope.state.changed`, `message.accepted`, `turn.started`, `assistant.delta`, `tool.*`, and `turn.*` events.

The Agent Console should render coordinator state rather than infer state from process presence. A compatibility adapter for `/api/state`, `/api/events`, and `/api/message` is optional and removable after migration.

## Version manager

Updates run outside the active Bridge process. The running process may check and announce an update, but cannot overwrite itself.

The update manager operates on a compatibility bundle:

```text
bundle version
  bridge version + integrity
  codex CLI version/range + integrity
  lark-cli version/range + integrity
  protocol revision
  minimum data schema
```

Activation sequence:

1. resolve a compatible bundle from the selected release channel;
2. download/install into version-specific staging directories;
3. verify hashes, executable versions, protocol capabilities, and configuration readability;
4. ask the Bridge to stop accepting new turns and drain active turns;
5. stop the old service and atomically switch the active-version pointer;
6. start and run health checks (Bridge, App Server initialize, account/config visibility, and skill listing);
7. commit the activation or roll back the pointer and restart the previous bundle.

The first implementation should support manual `update check/apply/status/rollback`; unattended scheduling should be enabled only after rollback is proven.

## Expected code changes

### New Codex runtime

- `src/agent/codex/app-server/client.ts`: typed JSON-RPC transport.
- `src/agent/codex/app-server/supervisor.ts`: child lifecycle and recovery.
- `src/agent/codex/app-server/protocol.ts`: narrow checked DTO boundary; generated protocol output is used for validation, not required at consumer build time.
- `src/agent/codex/app-server/events.ts`: App Server notification to bridge-domain event translation.
- `src/runtime/codex-runtime-coordinator.ts`: per-scope actors, state machine, queue, reconciliation.
- `src/runtime/codex-scope.ts`: state and command reducer if the coordinator becomes too large.

### Existing runtime integration

- `src/cli/commands/start.ts`: construct/start/stop the App Server supervisor and coordinator for Codex profiles.
- `src/bot/run-flow.ts`: split common policy preparation from Claude run submission; route Codex messages to the coordinator.
- `src/bot/channel.ts`, `src/commands/index.ts`, `src/card/dispatcher.ts`, `src/bot/comments.ts`: replace direct `ActiveRuns.interrupt` calls with an asynchronous runtime control interface.
- `src/agent-console/server.ts`: consume the runtime control/query interface and expose v2 API/events.
- `src/agent/types.ts`: keep generic domain events where useful, but do not force steer into the legacy `AgentRun` process abstraction.
- `src/session/codex-history.ts`: reuse the long-lived App Server client rather than spawning a second server when the Bridge is running.
- `src/agent/codex/adapter.ts`: retain temporarily for fallback and tests, then deprecate after rollout.

### Configuration

- `src/config/profile-schema.ts`: add explicit Codex runtime mode and bounded steer/drain/restart timeouts.
- Preserve current `codexHome`, `inheritCodexHome`, sandbox, model, user-config, rules, and Lark environment resolution exactly.
- Add update channel/policy only after update targets and platform scope are confirmed.

### Frontend

- `assets/agent-console/app.js`: submit v2 messages, show scope state, queued/steered messages, stop progress, and runtime health.
- `assets/agent-console/styles.css`: state badges and queued message treatment.
- Existing local modifications in these files must be merged, not overwritten.

### Update subsystem

- `src/update/manifest.ts`: compatibility bundle and validation.
- `src/update/resolver.ts`: release-channel resolution.
- `src/update/installer.ts`: staged version installation and integrity verification.
- `src/update/activator.ts`: drain, atomic activation, health check, rollback.
- `src/cli/commands/update.ts`: check/apply/status/rollback commands.
- `src/cli/index.ts`, service/launcher code, and profile schema: command registration and active-version launch.

## Tests and acceptance gates

### Runtime contract

- fresh scope starts a thread and turn;
- existing scope resumes the catalog thread;
- a second message during a steerable turn calls `turn/steer` and never starts another turn;
- messages during stop/drain queue and start only after terminal confirmation;
- interrupt RPC success without terminal notification does not release the scope;
- App Server crash causes deterministic failure/reconciliation and no duplicate turn;
- notifications are correlated by both `threadId` and `turnId`;
- different scopes can run concurrently without cross-delivery;
- non-steerable turns use the documented queue behavior.

### Data and configuration

- the effective `CODEX_HOME` and Lark environment match the old adapter for every profile mode;
- existing catalog thread IDs resume without migration;
- skill/plugin listing and selected-skill execution work before and after restart/update;
- credentials, workspaces, secrets, and session files remain byte-for-byte untouched unless explicitly updated by their owning store.

### Update safety

- incompatible bundles are rejected before drain;
- failed download/verification never changes the active version;
- failed health check rolls back automatically;
- update interruption at each activation step leaves either the old or new complete version active;
- rollback still reads all existing user data.

### Quality gates

- focused unit and process tests for the App Server client/supervisor/coordinator;
- regression tests for Claude execution;
- Agent Console API and UI tests;
- `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Delivery phases

1. App Server client, supervisor, fake server fixtures, and protocol tests.
2. Codex coordinator with start/resume/steer/interrupt/drain and channel integration.
3. Agent Console v2 and observability; optionally retain a thin v1 adapter.
4. Manual compatibility-bundle update/check/apply/rollback.
5. Unattended update scheduling after production rollback evidence.

Each phase is separately reviewable and releasable. Do not combine the runtime replacement and unattended self-update in one activation.

## Open decisions

1. Update targets: Bridge + Codex CLI only, or also `lark-cli`? Recommended: manage all three in one compatibility bundle.
2. Platform scope for the first updater: Windows only, or Windows/macOS/Linux? Recommended: keep platform interfaces cross-platform but ship Windows first.
3. Update automation: manual apply first, or unattended from the first release? Recommended: manual apply/rollback first, then opt-in unattended updates.
4. Compatibility API: retain a thin v1 Agent Console adapter for one release, or make a direct v2 cutover? Recommended: thin adapter for one release because it is cheap rollback insurance, without constraining the internal design.
5. Subagent model: requested `5.6 luna` is not available in this environment. Recommended substitute: `gpt-5.6-sol` for both coder and reviewer, in separate contexts.
