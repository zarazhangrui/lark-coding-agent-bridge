# Lumos Bridge Handoff

Updated: 2026-08-12

## Completed in the source tree

- Replaced one-Codex-process-per-message execution with a shared persistent Codex App Server transport.
- Added protocol compatibility verification, hidden read-only warmup, thread resume, cancellation, crash recovery, process-group reaping, background-terminal cleanup, and per-thread cleanup barriers.
- Enforced fixed Wan-only authorization across IM, topics, comments, cards, and meeting entry points.
- Enforced real structured mentions for Lumos groups and topics, with only signed authorized card callbacks as an exception.
- Made topic identity recovery fail closed and preserved one Feishu topic to one Codex thread.
- Added incremental topic cursors with bounded recent IDs, overlap recovery, and bounded pagination.
- Forced all turns containing external history, quotes, forwards, attachments, comments, cards, or meeting transcripts to deterministic read-only, network-disabled execution.
- Isolated Lumos from the user's global Codex configuration with a profile-local Codex home.
- Disabled Feishu publication of raw reasoning and tool-progress blocks for Lumos.
- Fixed supervisor start, stop, restart, and generation-adoption races.
- Added safe App Server diagnostics without retaining raw stderr content.

## Local validation

The final source tree passed:

```text
pnpm test       108 files / 763 tests passed
pnpm typecheck  passed
pnpm build      passed
git diff --check passed
```

This is evidence for the current local source tree. It does not prove the installed global package or running daemon contains these changes.

## Not performed in this handoff

- No package installation.
- No service stop, restart, or daemon replacement.
- No commit or Git push.
- No live Feishu messages were sent.
- Live same-topic two-turn reuse and latency were not reverified.

## Next operational step

After Wan explicitly authorizes deployment, follow [operator-runbook.md](./operator-runbook.md): run the full preflight again, package the current tree, back up the installed version, replace the global package through its stable prefix, restart only the `lumos` profile, and perform the authorized two-message topic verification.

Until those steps are complete, report the state as “implemented and locally validated, not deployed or live-verified.”
