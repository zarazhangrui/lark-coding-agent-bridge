# Lumos Feishu Codex Bridge Architecture

## System boundary

The bridge connects a Feishu PersonalAgent to a local Codex App Server while enforcing Lumos-specific identity, topic, workspace, and trust boundaries in code.

```text
Feishu event
  -> generation intake gate
  -> fixed Lumos owner + structured mention gate
  -> topic identity recovery (fail closed)
  -> bounded context and attachment normalization
  -> deterministic run policy
  -> persistent Codex App Server turn
  -> same-topic streaming/final reply
```

Feishu remains the source of truth for message bodies. Local state stores only what is needed for continuity and idempotency, such as scope keys, message cursors, bounded recent message IDs, and Codex thread IDs. The bridge does not create a local archive of group conversations.

## Identity and authorization

The Lumos owner check is an intake boundary, not a prompt instruction. IM messages, comments, meetings, and card actions are checked before context reads or agent execution. Non-owner input is ignored.

In groups and topics, the current owner message must contain a real structured bot mention. A signed card callback is the only continuation exception. Historical content never carries authorization into the current turn.

## Topic isolation

A scope key combines the Feishu chat and topic thread. When an event omits `thread_id`, the bridge reads the raw message to recover it. A Lumos topic event that remains ambiguous fails closed and never falls back to the chat ID.

Each scope maps to a persisted Codex thread. `thread/start` creates it, `thread/resume` reloads it after an App Server restart, and `turn/start` creates each new interaction. Concurrent topics have independent routing even though they share one App Server process.

Topic history is fetched incrementally. A cursor stores the last trigger and a bounded set of recent message IDs. A one-page overlap catches eventually consistent late arrivals without replaying an entire long topic. Pagination is bounded by page count and elapsed time.

## Trust and run policy

The bridge separates current owner input from external context. Topic history, quotes, interactive cards, forwards, attachments, document comments, and meeting transcripts set `untrustedContext=true` in the run policy.

That flag deterministically overrides configured permissions to read-only. The App Server receives a read-only sandbox policy with network disabled. Text context that the protocol can represent is placed in `additionalContext` as untrusted; forwards and attachment-derived inputs also force the same read-only capability boundary.

The prompt still tells Codex how to interpret the content, but safety does not rely on model obedience. The sandbox and network policy enforce the no-side-effect boundary.

## Persistent App Server lifecycle

One bridge process owns one lazily started Codex App Server child. Startup performs:

1. process spawn with the profile environment;
2. protocol `initialize` / `initialized`;
3. a generated-schema compatibility check;
4. a hidden, ephemeral, read-only prime turn before the profile is reported online.

Virtual runs route notifications by server generation, thread ID, and turn ID. Normal completion, interruption, failure, and crash close outstanding tool events and clean thread background terminals. Per-thread cleanup barriers prevent a follow-up turn from racing a previous turn's cleanup.

Transport failure retires the server generation, fails active turns without replaying side effects, and reaps the process group. The next request starts a fresh generation and resumes the persisted Codex thread. Active prompts are never automatically replayed after an ambiguous crash.

## Profile-local Codex state

The Lumos runtime creates:

```text
~/.lark-channel/profiles/lumos/codex-home/
```

with private permissions. Only the authentication material required by Codex is linked into it. User-global Codex configuration, MCP definitions, plugins, and skills are not inherited. This prevents an authorized Lumos turn from acquiring unrelated tools or non-Lumos context.

## Runtime generation handoff

Supervisor start and restart use inactive candidate generations. A candidate can connect and warm up but cannot accept Feishu work until it is atomically adopted. Stop immediately closes intake, then tears down the matching bridge and agent generation. This avoids duplicate execution and old/new bridge-agent pairing races.

## Sensitive diagnostics

App Server stderr is drained but raw text is not copied into Feishu events or logs because it may contain headers, private URLs, or credentials. Diagnostics retain safe categories, byte counts, exit status, generation, process ID, thread ID, and turn ID.
