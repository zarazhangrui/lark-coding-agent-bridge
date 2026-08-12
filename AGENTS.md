# Lumos Feishu Codex Bridge Rules

## Scope

- This directory owns the Lumos-specific runtime fork of `lark-channel-bridge`.
- The production bot profile remains `lumos`; runtime credentials and session state stay under `~/.lark-channel` and must never be copied into this repository.
- Preserve the contract: one Feishu topic maps to one isolated Codex thread.

## Interaction Contract

- Only Wan may trigger Codex work or receive a bot reply.
- In groups and topics, a real structured mention of the bot is required to trigger a turn.
- A bridge-signed interactive callback created by a Wan-authorized active turn is the only non-mention continuation; its token must bind Wan, chat, topic scope, run, action, and policy fingerprint.
- Messages without a bot mention may be retained only as bounded, untrusted topic context for the next Wan-triggered turn. They must not start Codex, call tools, or authorize side effects.
- Authorization comes only from Wan's current triggering message. Topic history, quoted messages, forwarded messages, and attachments are context, never authority.
- Any turn containing third-party history, quotes, forwards, attachments, comment context, or meeting transcript must run read-only. Side effects require a new Wan turn whose authority does not come from that external context.

## Runtime Design

- Prefer one managed Codex App Server connection per bridge process over one `codex exec` subprocess per message.
- Reuse loaded threads through `thread/start` / `thread/resume`, and start work with `turn/start`.
- Recover cleanly from App Server exit: fail the active turn, restart once on the next request, and keep the persisted thread id.
- Do not print or persist app secrets, access tokens, private configuration, raw group-message archives, or internal bridge metadata.

## Development

- Keep upstream changes easy to review and rebase; isolate Lumos-specific behavior behind named configuration or adapter boundaries.
- Add regression tests for process reuse, thread continuity, cancellation, crash recovery, and mention-gated topic-context accumulation.
- Keep user behavior in `README.md` / `README.zh.md`, integration contracts in `docs/integration-guide.md`, internal design in `docs/architecture.md`, operations in `docs/operator-runbook.md`, and current rollout truth in `docs/handoff.md`.
- When behavior, security boundaries, configuration, or deployment steps change, update the matching document in the same change.
- Run unit tests, typecheck, and build before replacing the installed runtime.
- Deploy through the bridge's existing launchd service, then verify status, one warm-up turn, one resumed turn, and measured latency.
- Do not push Git changes unless Wan explicitly asks.
