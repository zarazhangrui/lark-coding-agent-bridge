# Proactive V3.2 — confirmed conditional collaboration

Tracking: #325. Builds on #323 / #324. This is human-owned follow-up tracking, **not** autonomous document/code execution. Existing confidence thresholds and reminder/document paths are unchanged.

## Observable behavior

`@teammate 等表格迁好后，告诉我怎么用` produces one proposal in the source thread. `弄好了告诉我该怎么做` is also supported, including a separate trailing request introduced by `顺便`/`另外`. The latter clause is not part of the proposed action. Quoted examples, negation, hypothetical failure cases and sensitive follow-on operations are excluded.

The source text supplies the prerequisite and feedback request; a single explicit mention supplies the proposed responsible person. A reply ID can attach the mentioned person's earlier message as context. Mere recency does not establish a dependency. No deadline is invented. No participant's acceptance, completion or permission grant is inferred from a mention.

| State | Owner operation | Result |
| --- | --- | --- |
| 待负责人确认 | 确认跟进 / `确认跟进 fu_…` | 等待前置事项 |
| 等待前置事项 | 前置事项已完成 / `前置完成 fu_…` | 待后续反馈; the downstream feedback is still open |
| 待后续反馈 | 已向对方反馈 / `已反馈 fu_…` | 已完成 |
| Open | 不再跟进 / `取消跟进 fu_…` | 已取消 |

The requester may retract an unaccepted proposal, but cannot accept or advance it for someone else. Ambiguous `这个完成了` asks which stage was completed and changes nothing. Unambiguous contextual phase commands work within the same thread; explicit IDs are recommended. Text commands older than the current proposal/confirmation do not advance it. An explicit owner confirmation of prerequisite completion is recorded as evidence; V3.2 does **not** independently inspect spreadsheets or infer completion from arbitrary group chatter.

`我的主动任务` includes this person's owned or requested collaborations alongside document tasks, with three entries per page. `我的协作跟进` is a topic-scoped text fallback showing up to ten recent items. Shared cards are visible to thread readers, not private dashboards. The original proposal card updates in place; no top-level test message is needed.

## Gates and safety

- Opt in with `proactiveObserver.conditionalFollowUps: true` (default false). Still requires the existing observer enabled/Active, chat allowlist and global kill switch. No new permissions.
- Grounded conditional requests can produce **reversible proposals** even when Jev scores `clarify` below its normal threshold or is unavailable. This does not lower the global threshold or authorize any tool execution. Jev receives mentions/reply linkage and explicit conditional-request guidance.
- Candidate extraction is intentionally bounded Chinese feedback wording, not general semantic planning. Missing/multiple assignees ask for clarification. Unmatched paraphrases are not guaranteed to be detected; add evidence-backed regressions before widening.
- Honor requester/owner pause and quiet hours on proposal creation. At most three proposals per day across either sender or recipient; active duplicates are suppressed. Existing accepted controls remain usable at the limit.
- Button actions bind owner, chat, actual card message and expected stage; serialization prevents double advancement. Legacy reminder controls cannot operate conditional records. Scheduled reminder scans exclude them entirely.
- Persist outbound claims before creating cards; ambiguous sends never cause automatic duplicate cards. Patch failures preserve business state and surface a sync warning; click responses carry the authoritative card.

## Data and rollback

Schema 3 gains additive `FollowUp.condition` and `ObserverMessage.replyToMessageId`. Conditional pending and terminal items can have no `dueAt`. Original deadlines, reminders, task artifacts and processed IDs are retained. History recovery preserves `parent_id` and watches pending conditional threads.

Preferred rollback: disable `conditionalFollowUps` while retaining this reader, preserving all conditional records. **Older V3.1 readers reject no-deadline conditional records**, so do not restart an old binary against the live state without first preserving a separate copy. Runtime rollback requires stopped work and a compatible state restoration/migration; do not silently restore a stale ledger over newer user activity.

## Verification

Regression tests cover the low-score reported sentence, distinct safe/permission clauses, common variants and counterexamples, source linkage, owner/card/chat/stage/time binding, pause/Shadow, unchanged deadlines, restart, original-card updates, deduplication and normal reminder/document regressions. Live pilot evidence is recorded separately; unit tests do not establish native button or message-delivery reliability. No historical messages are replayed to create new proposals on deployment.
