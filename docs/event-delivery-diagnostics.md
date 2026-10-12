# Event delivery diagnostics and bounded recovery

Tracking: #329. This is a transport diagnostic/hardening change, not a claim
that all upstream delivery failures have been fixed.

## Separate the receipts

For a message or native card click, distinguish platform delivery, SDK frame
receipt, normalized handler receipt, durable task state, and visible card update.
A historical message recovery does not prove the WebSocket is dead. A platform
delivery success does not prove that this bridge was the receiver: Feishu
distributes events among connections sharing an app ID. Text controls are not
an acceptance test for native buttons.

Set `LARK_CHANNEL_TRANSPORT_DIAGNOSTICS=1` only when correlating delivery. The
SDK debug logger retains a strict allowlist of routing identifiers and safety
drop categories. It never logs raw frames, message bodies, callback values,
credentials, or request headers. SDK versions that log `envelope.data` as
`undefined` still provide frame/trace identifiers. Disable the flag to return
to normal SDK info logging.

## Recovery guard

History-triggered reconnect attempts are bounded to one per five minutes per
managed profile, including failed attempts. The bound belongs to the supervisor
and survives channel replacement; history polling continues during the cooldown.
Manual reconnect and the independent connection-liveness watchdog are unchanged.
Active task/run checks remain in place. This prevents an immediate recovery /
reconnect loop, but does not repair another consumer acknowledging our events.

## Slow native card callbacks

The callback returns a provisional receipt after 1.5 seconds to stay within
the platform deadline. The eventual result must not be discarded by the
`Promise.race`: when it contains a card, send the complete authorized payload
through the delayed card-update API with the original callback token. Check
the API business code and report failure without logging the token. Fast
callbacks still return their card directly; toast-only results do not create
another message. This fixes a confirmed late-result loss in the application,
independently of whether every callback is delivered to this receiver.

## Live acceptance

Use an existing approved test topic, one test task, and the real initiating user.
Do not broaden permissions, lower confidence, replay other people's tasks, or
disable meeting/mail consumers merely because they share credentials. Inspect
their actual connections first.

Record independent native start and accept clicks, the exact message/card IDs,
timestamps, handler receipts, durable state, and visible results. Read back the
generated test artifact and verify previous artifacts remain intact. Repeat
after idle and after a controlled restart. A successful single click does not
establish reliability. If frames never reach the SDK despite platform success,
investigate app-wide receiver routing instead of changing business rules.

## Release integrity

Verify the real path of the executable, not just its displayed command line.
When copying a staged runtime, preserve relative symlinks (`verbatimSymlinks`)
or reinstall dependencies; Node's default recursive copy may leave `.bin`
pointing to the previous runtime. Build explicitly and use `npm pack
--ignore-scripts` after verification to avoid package-manager bootstrap changes.
