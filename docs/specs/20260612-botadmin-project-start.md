# botAdmin And Project Start Spec

Date: 2026-06-12
Status: implementation review

## Background

Feishu group project collaboration needs a bot-to-bot operating role that can
bootstrap and maintain project groups without giving bots the full human admin
permission set.

The bridge previously had only owner/admin style controls. That was too broad
for delegated bot operation: a bot with admin-equivalent permission could manage
human admins or add more privileged bots, creating an escalation loop.

This spec introduces a separate `botAdmins` access tier and a lightweight
`/project start` workflow for binding a group session to a project workspace.

## Goals

- Allow trusted bot agents to run operational group commands.
- Keep all role and access-list management human-admin gated.
- Require structured Feishu mentions for target resolution.
- Prevent lockout when removing human admins.
- Provide a deterministic `/project start <path>` workflow that validates the
  workspace before resetting the group session.
- Persist `botAdmins` in both root and profile config shapes.
- Show bot admins in the configuration card.

## Non-Goals

- Do not grant bots owner or human-admin authority.
- Do not allow bots to add users, add admins, add bot admins, or remove human
  admins.
- Do not parse plain text such as `@Name` as an authorization target.
- Do not implement git clone, template generation, or project scaffolding in
  `/project start`.
- Do not solve remote/devbox workspace mounting in this change.

## Roles

| Role | Source | Scope |
| --- | --- | --- |
| Owner | creator controls | Full human authority |
| Human admin | `access.admins[]` | Full human admin commands |
| Bot admin | `access.botAdmins[]` | Operational group commands only |
| Non-admin | none | Public/help/status behavior only |

`botAdmins[]` entries are bot identities. They must not pass the human-admin
gate.

## Command Gates

Public self-service commands available to any allowed caller:

- `/status`
- `/help`
- `/new`
- `/reset`
- `/resume`
- `/stop`
- `/timeout`
- `/doc`

Human-admin commands:

- `/account`
- `/config`
- `/exit`
- `/reconnect`
- `/doctor`
- `/botAdmin`

Operational commands allowed for bot admins:

- `/cd`
- `/ws`
- `/project`
- `/invite`
- `/remove`
- `/ps`

`/invite` and `/remove` are still handler-gated:

- bot admins may use only `group` operations.
- bot admins must be rejected for `user`, `admin`, and `botAdmin` targets.

## Permission Matrix

| Operation | Owner | Human admin | Bot admin | Non-admin |
| --- | --- | --- | --- | --- |
| `/invite group` | yes | yes | yes | no |
| `/remove group` | yes | yes | yes | no |
| `/cd` | yes | yes | yes | no |
| `/project start` | yes | yes | yes | no |
| `/status` / `/help` / `/new` / `/reset` / `/resume` / `/stop` / `/timeout` / `/doc` | yes | yes | yes | yes |
| `/ps` | yes | yes | yes | no |
| `/invite user` | yes | yes | no | no |
| `/invite admin` | yes | yes | no | no |
| `/remove admin` | yes | yes | no | no |
| `/botAdmin add/remove/list` | yes | yes | no | no |
| `/account` / `/config` | yes | yes | no | no |

## botAdmin Management

The command is:

```text
/botAdmin add @Bot
/botAdmin remove @Bot
/botAdmin list
```

Requirements:

- Dispatch must route `/botAdmin` through the human-admin gate.
- Targets must come from structured Feishu mentions.
- Non-bot mention targets must be rejected.
- Repeated add/remove should be idempotent.
- Config persistence must preserve existing access fields.

## Anti-Lockout

Removing human admins must leave at least one human admin in `access.admins[]`.

If a remove operation would empty `admins[]`, the command must reject and leave
disk config unchanged.

## Structured Mention Rules

All access-list mutation commands must use structured `mentions[]` from the
message event. Plain message text that looks like `@Name` is not a target.

Acceptance case:

```text
/invite user @Someone
```

with an empty structured mentions array must be rejected as "no mentioned user
detected".

## Project Start Workflow

Command:

```text
/project start <absolute-or-tilde-path>
```

State flow:

1. Build an idempotency key from scope and requested path.
2. Reject duplicate in-flight starts for the same key.
3. Validate that the path is absolute or starts with `~/`.
4. Expand `~/` and resolve the working directory.
5. Fail before session mutation if the directory does not exist.
6. Interrupt the current session if needed.
7. Set cwd.
8. Clear the session.
9. Return a structured receipt.
10. Always release the in-flight key in `finally` so retry is possible.

The workspace switch must happen before session reset. Invalid paths must not
mutate cwd or clear the session.

## Config And Card Shape

Config schemas must include:

```ts
access: {
  admins: string[];
  users: string[];
  groups: string[];
  botAdmins: string[];
}
```

The config card must display bot admins separately from human admins.

## Required Tests

- bot admins pass `canRunBotAdminCommand`.
- bot admins do not pass `canRunAdminCommand`.
- `isBotAdmin` is an exact list membership check.
- `/botAdmin add/remove/list` persists and renders correctly.
- regular allowed users can run public self-service commands.
- unsigned public command card callbacks work, while unsigned admin command
  callbacks stay gated.
- bot admins can run operational commands.
- bot admins cannot run role-elevation commands.
- text-only fake `@Name` is rejected.
- removing the last human admin is rejected and leaves disk unchanged.
- `/project start` succeeds for an existing absolute path.
- `/project start` rejects missing paths.
- `/project start` rejects relative paths.
- profile schema/runtime/migration tests include `botAdmins`.

## Verification Commands

```bash
pnpm exec vitest run \
  tests/unit/policy/access.test.ts \
  tests/integration/commands/commands-v1.test.ts \
  tests/integration/config/profile-migration.test.ts \
  tests/unit/config/profile-schema.test.ts \
  tests/unit/runtime/profile-runtime.test.ts

pnpm test
pnpm build
pnpm typecheck
```

Known pre-existing failures at the time this spec was written:

- `tests/unit/cli/preflight.test.ts`
- `tests/integration/cli/secrets-profile.test.ts`
- `src/media/cache.ts` typecheck error for `downloadResourceToFile`

These are not part of the botAdmin/project start change.
