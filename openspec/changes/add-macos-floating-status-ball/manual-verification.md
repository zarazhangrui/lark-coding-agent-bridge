# Manual Verification: macOS Floating Status Ball

## Single Profile

- Start `lark-channel-bridge run` on macOS.
- Confirm exactly one floating ball appears.
- Confirm it changes from `connecting` to `idle` after the bot connects.
- Send one message and confirm the ball enters `thinking`, `tool_running`, or `streaming`.
- Let the run finish and confirm the ball returns to `idle`.

## Multiple Profiles

- Start two profiles with different names.
- Confirm the desktop still shows one floating ball.
- Hover over the ball and confirm both profile names appear.
- Put one profile into a run and confirm aggregate state follows the busier profile.
- Queue a message during an active run and confirm the profile row shows queued count.

## Hover And Layout

- Move the ball near the left, right, top, and bottom screen edges.
- Hover and confirm the expanded list stays inside the visible screen frame.
- Move the mouse out of the ball/list and confirm it collapses.

## Drag Persistence

- Drag the collapsed ball to a new location.
- Stop and restart the helper.
- Confirm the ball restores to the saved location.
- Change displays or resolution so the old location is off-screen.
- Restart and confirm the ball moves to a visible safe location.

## Reconnect And Errors

- Temporarily interrupt network connectivity.
- Confirm the ball shows `reconnecting`.
- Restore connectivity and confirm it returns to the current idle/queue/run state.
- Trigger an agent error or idle timeout and confirm only a low-sensitive error state appears.

## Disable And Failure Paths

- Run `lark-channel-bridge run --no-floating-ball` and confirm no helper starts.
- Configure `"desktop": { "floatingBall": { "enabled": false } }` and confirm no helper starts.
- Set `LARK_CHANNEL_FLOATING_BALL_HELPER` to a missing path and confirm bridge startup continues with only a warning.
