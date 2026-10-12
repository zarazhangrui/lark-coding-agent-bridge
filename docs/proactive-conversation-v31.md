# Proactive V3.1 — contextual controls and visible status

Tracking: upstream #323. Builds on V3 (#321 / #322); V3's source scope, document-only execution, owner authorization and default-off configuration remain unchanged. No autonomous task execution, new permissions, global group rollout or process-pool queue is introduced.

V3.2 adds a separately opted-in [conditional collaboration follow-up](proactive-collaboration-v32.md) path and includes related items in the task overview. Its human-owned state does not authorize document execution.

## User-visible contract

| In the original topic | Result |
| --- | --- |
| `我的主动任务` / `任务进度` / `任务总览` | One persistent overview card for this author and topic: Chinese status, current blocker, next action and source/document links. Later queries update that card and reply with its link. |
| `我的主动任务 第2页` | Three entries per page; active tasks precede terminal tasks. No other author's or topic's entries are included. |
| `开始吧` / `开始整理吧` / `可以开始了` / `整理` | Starts only a uniquely applicable proposed task belonging to this author in this topic. |
| `这个完成了` / `验收通过` | Accepts a uniquely applicable delivered task; does not finish a still-running task. |
| `精简一点，把问题放前面` / `改成…` / `增加…` | Updates a uniquely applicable non-running task's requirements. Creates a new unconfirmed revision; never starts automatically. |
| `明天再看` / `改到明天吧` | Schedules a review of a uniquely applicable delivered artifact. This is not scheduled execution of a proposal. |
| `补充 pt_…：具体要求` | Explicitly selects a task. Can revise an already accepted task without altering the earlier document; generic vague text cannot reopen accepted work. |

This is a bounded set of contextual expressions, not unrestricted language understanding. `好`, `行`, quoted agreement, negations and sentences containing extra operations are not execution consent. Existing exact ID commands and card buttons remain supported. Text actions get explicit receipts in the same topic.

If several tasks can satisfy the requested action, list the IDs and ask the author to select one. For ambiguous completion/revision/cancellation/postponement with an unrelated open reminder, ask whether the user means the task or reminder; mutate neither. If there is no applicable task, leave reminder handling to V2. Older recovered text cannot approve or modify a later revision: compare message creation time against the current approval request time.

## Reliability and limits

- Serialize task mutations and overview updates. Persist approval and outbound creation claims before side effects. No new top-level group messages.
- Busy task worker: show `尚未启动，也未排队`; require a later confirmation. Executor capacity rejection is shown in Chinese, with retry guidance. Do not claim an unimplemented queue.
- Personal pause: text operations explain that execution is paused; overview is still readable. Shadow/off still sends no proactive messages or runs.
- Task and overview patches use the existing authenticated client, but require explicit Feishu `code: 0`. An HTTP response without business success is not a successful update.
- Task-card patch failure is persisted as `cardSyncError`, shown in overview and text action receipts, and cleared after a later successful update.
- Overview creation is attempted once per author/topic. An ambiguous send result is not automatically retried as a new card. An explicit query falls back to a small text status summary and asks the maintainer to reconcile the original card.
- Overview updates use persistent state, not a second task ledger. A missing item does not prove a message was never received; diagnosis still needs message time/ID and delivery evidence.
- Feishu cards are shared topic messages, not private dashboards. The list is author-scoped but readable by people who can read that topic; no access expansion is performed.
- V3's callback binding, response deadline, authoritative card return, timeout, interrupted-task recovery, uncertain-publication protection and source-reading constraints remain in force. Failure before platform event delivery cannot be fixed by intent parsing alone.

## State and rollback

Schema remains 3 with additive `taskDashboards`, `approvalRequestedAt`, `cardSyncError` and `reviewReminderAt`. Old records use creation time as the approval-time fallback. Existing V1/V2 reminders, preferences, message deduplication, task artifacts and review reminder IDs are preserved. Revision clears the current draft but retains prior published artifacts. A prior review reminder is cancelled and reused only after a new explicit review request.

Before deployment, save startup/config/state, build and verify package hashes, ensure no document/coding task is running, install to a new versioned runtime path, then restart only the pilot service. Read back actual process path, hashes and active configuration. Roll back to the saved V3 runtime after ongoing work stops. Preserve the current state file separately: old V3 loads schema 3 but may drop additive overview metadata on its next write.

## Acceptance evidence required

Automated: contextual/exact commands; non-consent expressions; author/topic/revision isolation; competing reminder and task; duplicate event; busy/paused/failure receipts; overview pagination, persistence and ambiguous-send protection; nonzero platform error rejection; existing V2 and normal mention regressions.

Live pilot (separate from unit claims): in the existing test topic, refresh the overview, revise a designated test task (not a user's accepted deliverable), confirm via natural text, observe progress and verified document delivery, then accept and confirm both original and overview cards update. Native button interaction is verified separately from natural-language controls. Never add a new top-level test message. Do not describe unperformed live cases as passed.
