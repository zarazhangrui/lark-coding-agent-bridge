# Proactive V4 pilot: reviewed task continuity

Tracking: #327. Additive to the unmerged V3.2 stack (#326); no automatic merge.

## Problem and scope

After a document task is proposed, later topic messages can add material, reveal a blocker, change an expected date or report progress. Creating another task loses continuity; silently changing an approved run loses consent. This slice stages source-grounded updates on the existing task instead.

- Opt in with `proactiveObserver.taskContinuity: true` (default false). Existing execution enablement, Active mode, chat allowlist, personal pause and quiet hours apply. No new permissions or chat scope.
- Only the same owner in the same chat and exact topic can contribute. An explicit task ID or reply edge binds a task. Without a binding, exactly one open task in a topic is required. Multiple matches ask for an ID; a concurrent personal reminder requires an explicit binding. Bare top-level chat updates are not implicitly associated.
- Accepted/cancelled tasks are not reopened by observations. Existing explicit `补充 pt_ID：...` can reopen an accepted document, as in V3.1.
- Jev adds one structured classification to the existing decision call when eligible tasks exist. Semantic updates need >=0.85 confidence; bounded literal statements work if the classifier is unavailable. Neither path grants execution consent. No global threshold changes.
- Store the original message, kind, timestamp and pending/adopted/dismissed outcome. No model-generated target IDs or automatic execution plans.

## User-visible loop

1. In the original topic, write `资料在这里：...`, `目前还缺客户名单，卡住了`, `验收时间改到周六下午`, or `目前进展：第一部分已完成`. With multiple possible targets, prefix the exact task ID.
2. The original card and an already-created `我的主动任务` dashboard show pending updates and a next-step suggestion. No new proposal card per update. Missing card synchronization is visible and the dashboard remains a fallback.
3. `采用补充 pt_ID` (or its button) incorporates the pending batch into a new proposed revision, revoking previous consent. `忽略补充 pt_ID` leaves requirements/artifacts unchanged. Card actions bind the exact pending batch as well as revision, owner, chat and card ID. Text actions older than the newest pending input are rejected.
4. Adoption does **not** execute. Review the new scope and separately send `开始 pt_ID`. Existing documents are retained; new execution creates a new document.

Pending input blocks start/retry/accept until adopted or dismissed. An in-flight worker keeps its confirmed snapshot; adoption is blocked until it finishes or is cancelled. New input never changes its source list or draft mid-run. Schedule updates are contextual requirements, **not** automatic rescheduling of reminders, calendar events or execution. Blocker advice does not claim the missing input has been obtained.

## Bounds, data and rollback

At most three pending messages, each <=2,000 characters; up to 20 stored update records per task. Oversized input is rejected visibly, not silently truncated into requirements. Cumulative requirements <=24,000 characters; adoption is all-or-nothing. Card previews truncate visibly and refer to the source topic. Model/context input remains bounded and treated as untrusted data. Only adopted messages enter execution context.

Schema 3 gains optional `updates`. Old tasks load unchanged. Malformed saved updates keep the task but move active records to needs_input with a new revision and clear consent; do not silently discard approval data and leave an executable task. No historical replay, automatic migration of chat history, or cross-topic/person association.

Preferred rollback: disable `taskContinuity` with this reader; it stops new capture while still allowing owners to resolve pending updates. **Do not run V3.2 against unresolved V4 updates:** it ignores pending-approval gates. Preserve live state before any runtime rollback; never restore an old snapshot over newer user actions. Existing global/execution pause still stops execution.

## Acceptance

- A pending update edits the original card/dashboard without creating a task or invoking the executor.
- Adoption increases revision and preserves artifact history but does not execute; a separate fresh start does.
- Ignoring a batch preserves original requirements and revision.
- Old/missing batch token, wrong owner/chat/card/revision and old text cannot approve new input.
- Multiple tasks, concurrent reminders, off/shadow/personal pause/quiet hours and closed tasks obey their boundaries.
- In-flight run/publish never uses unadopted inputs; pending updates survive persistence/restart.
- Model outage has bounded literal fallback, not permission expansion.
- Existing V1–V3.2 tests remain green; full test/typecheck/build evidence required before rollout.
- Live test stays in the existing pilot topic. Text control and native button delivery are separate checks; intermittent upstream callback transport is not solved or declared solved by this feature.

## Not this version

No autonomous task decomposition/execution, cross-person assignment, group-wide memory, attachment OCR, automatic blocker resolution, native Feishu Task/Base/calendar mutations, recurring workflows or editing an existing document. Those remain later roadmap work.
