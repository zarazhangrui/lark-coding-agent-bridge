# Quiet proactive replies

This adjustment narrows unsolicited participation without raising all model
confidence thresholds or changing delivery/reconnection behavior.

- Whole-message acknowledgements (`好的`, `收到，谢谢`, `哈哈哈`, emoji) remain
  context but do not call the classifier or create a response.
- General questions, hypothetical examples and statements of ongoing work do
  not create new reminder proposals merely because the model selects clarify.
- New document proposals require a request for help. A high model score on
  `资料还没整理` or `周报模板挺好看` alone is not enough. Explicit requests such
  as `我想要份周报模板` still work without an @mention.
- Unsupported/speculative document actions no longer send an unsolicited
  generic escalation message. The existing explicit @bot path is unchanged.
- Reminder receipts, proposals, due notifications, dashboards and feedback all
  reply inside the source message's thread, even for a top-level source.
  Existing task and collaboration replies already use this routing.
- Newly created reminder threads are looked up and stored so subsequent
  topic-scoped completion/postponement remains associated with the same item.
  Lookup failure never retries a successful send. Card controls still work;
  text association remains unverified until a real thread ID is available.

No changes to group access, Active/Shadow mode, ownership, execution consent,
global confidence thresholds or existing accepted tasks. No history replay.
No fallback to a new top-level message when threaded delivery fails.

## Verification and rollout boundary

Unit regressions exercise silence despite high model scores, acknowledgement
filtering, real reminder intent, existing task continuation and threaded
delivery, including lookup failure without duplicate sends. Native Feishu
delivery remains a separate live acceptance step.

This patch was prepared in an isolated checkout based on `2e5d92f`. It does not
change or restart the cloud deployment. Integrate it after coordinating with
the ongoing event-delivery repair; do not deploy over an active run.
