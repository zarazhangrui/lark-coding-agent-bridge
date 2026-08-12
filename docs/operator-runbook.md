# Lumos Bridge Operator Runbook

## Safety rules

- Do not deploy from `npx`, a repository-local binary, or a temporary package cache. The service manager records the executable path.
- Do not copy `~/.lark-channel`, app secrets, tokens, or the profile Codex home into the repository or a deployment artifact.
- Do not push Git changes as part of deployment.
- Keep source validation, package installation, service restart, and live Feishu verification as separate states.
- Sending Feishu test messages requires explicit authorization of recipient, content, and identity.

## Preflight

From the repository root:

```bash
pnpm ci:local
git status --short
command -v lark-channel-bridge
lark-channel-bridge status --profile lumos
```

`pnpm ci:local` runs diff checking, the full test suite, type checking, and the production build. A green result validates the source tree only.

Before replacing the installed package, record:

- the absolute global bridge binary path;
- the currently installed package version;
- the Lumos service status and process IDs;
- a recoverable copy of the currently installed package artifact or exact version;
- the current profile config without printing secrets.

## Package and install

Build a package from the validated source tree:

```bash
pnpm pack
```

Stop the existing profile using the same absolute global binary recorded during preflight. Install the produced tarball into that binary's global prefix, then start the profile using the absolute global binary again.

Do not run service `start` from `pnpm exec`, `npx`, or the repository because launchd/systemd may persist that transient path.

## Post-install checks

Run these checks before calling the bridge online:

```bash
<absolute-global-bin> status --profile lumos
tail -n 100 ~/.lark-channel/profiles/lumos/logs/daemon/*.log
```

Confirm from safe diagnostics that:

- the bridge service is running once;
- exactly one current Codex App Server generation is ready;
- the configured Codex protocol passed compatibility verification;
- warmup finished before intake was enabled;
- no restart loop or repeated transport error is present;
- the Lumos profile uses its profile-local Codex home.

Raw credentials, authorization headers, and full private URLs must never be copied into an issue or chat.

## Authorized live verification

After Wan authorizes the exact test messages and target topic:

1. In the Test group, create or open one topic.
2. Wan sends a structured `@Bot` message requesting a short response.
3. Confirm the response stays in the topic and record time-to-first-response.
4. Wan sends a second structured mention in the same topic.
5. Confirm logs show the same Codex thread ID, a different turn ID, and the same App Server process ID.
6. Send an ordinary non-mention message and confirm it starts no run.
7. Do not ask a colleague to trigger the bot; the owner gate is verified by automated tests unless Wan explicitly authorizes a live identity test.

## Troubleshooting

### Bot is silent

Check service status, Feishu bot membership, event subscription, and whether Wan used a structured mention. Silence for non-owner or non-mention messages is expected.

### Topic identity cannot be recovered

The bridge intentionally refuses to run. Retry the mention after Feishu has materialized the topic message. Do not weaken the fallback to chat-wide scope.

### App Server protocol is incompatible

Startup reports that required `TurnStartParams` fields are missing. Use the configured Codex binary version that supports `additionalContext` and `clientUserMessageId`; do not bypass the gate because doing so can silently drop untrusted context.

### App Server takes a long time to answer

Inspect safe lifecycle timestamps for spawn, initialize, prime, thread resume, and turn start. A warm follow-up should not include process initialization. Repeated MCP HTTP failures, model-list refresh timeouts, or response transport failures indicate the Codex environment or network is unhealthy, not Feishu typing latency.

### Process exits or a turn is stopped

The active turn fails without automatic replay. The process group and background terminals are cleaned, and the next request starts a new generation and resumes the persisted thread. Confirm no duplicate side effect occurred before asking Wan to retry.

## Rollback

1. Stop the Lumos profile with the absolute global binary.
2. Reinstall the previously recorded package artifact or exact version into the same global prefix.
3. Start the Lumos profile with the same absolute global binary.
4. Verify service status and logs.
5. Report source state, installed package state, daemon state, and live Feishu state separately.
