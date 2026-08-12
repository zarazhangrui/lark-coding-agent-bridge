# Lumos Feishu Agent Integration Guide

## User goal

The Lumos profile lets Wan start and continue Codex work from a Feishu topic without copying the conversation into Codex manually. The interaction contract is intentionally narrow:

1. Invite the PersonalAgent bot to the target group.
2. Start or open a Feishu topic.
3. Wan sends a current message with a real structured `@Bot` mention and a Lumos task.
4. The bridge resolves the topic identity, gathers bounded context, resumes that topic's Codex thread, and replies in the same topic.
5. Later Wan mentions in the same topic continue the same Codex thread.

Each topic is isolated. The bridge never substitutes chat-wide state when it cannot prove the topic identity.

## Trigger and authorization rules

- The authorized owner is fixed by the Lumos runtime policy. Generic `/invite` allowlists cannot widen this boundary.
- Non-owner messages trigger no reply, analysis, tool call, draft, or background work.
- Wan's ordinary group or topic messages do not trigger a turn. They must contain a structured mention of the bot.
- `@all`, quoted text that visually contains the bot name, and plain text such as `@Bot` do not count.
- A bridge-signed interactive callback from an already authorized turn may continue without another mention. Its token is bound to the owner, chat, topic scope, run, action, and policy fingerprint.
- Authorization comes only from Wan's current triggering message. Old topic messages and referenced content never grant authority.

## Context and side effects

The bridge can include recent topic messages, quotes, forwarded messages, attachments, comment history, and meeting transcripts so Codex understands the discussion. These sources are untrusted.

Any turn containing untrusted external context is forced to:

- read-only filesystem access;
- no network access;
- no external writes or sends;
- no approval bypass into a writable turn.

This makes a request such as “summarize the discussion above” safe to run as a context-reading turn. To perform a side effect afterward, Wan sends a new, explicit current command whose authorization does not come from the earlier external content. The new turn is evaluated independently.

## Codex App Server configuration

The Lumos profile uses the persistent App Server transport:

```json
{
  "agentKind": "codex",
  "codex": {
    "transport": "app-server",
    "ignoreUserConfig": false,
    "ignoreRules": false
  }
}
```

The runtime creates a private profile-local Codex home automatically. Do not point the Lumos profile at the user's global `CODEX_HOME`, and do not copy global MCP, plugin, skill, or config files into the profile directory.

Startup verifies that the configured Codex App Server protocol supports the fields required to keep trusted user input separate from untrusted context. An incompatible binary fails startup with a clear error instead of silently dropping context.

## Expected Feishu behavior

| Situation | Result |
|---|---|
| Wan mentions the bot in a valid topic | Starts or resumes that topic's Codex thread |
| Wan follows up in the same topic with another mention | Reuses the same thread and starts a new turn |
| Wan writes without mentioning the bot | No turn starts; the message may become bounded untrusted context later |
| Another person mentions the bot | Silent; no work starts |
| Topic identity cannot be recovered | The bridge asks Wan to retry; no chat-wide fallback |
| Context contains history, files, forwards, or transcripts | The turn is forced read-only |
| App Server exits during a turn | Current turn fails; the next request starts a new server generation and resumes the persisted thread |

The Lumos profile publishes concise status and final output. It does not expose raw reasoning or tool-progress blocks in Feishu.

## Verification boundary

Repository tests prove local routing, policy, process reuse, thread continuity, cancellation, and crash recovery. They do not prove that the installed daemon, Feishu permissions, group membership, resource ACLs, or live latency are currently correct. Follow the live checks in [operator-runbook.md](./operator-runbook.md) after deployment.
