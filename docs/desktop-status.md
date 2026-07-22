# macOS Floating Status Ball

On macOS, `lark-channel-bridge` starts a small floating desktop status ball by default. It reads local status snapshots from `~/.lark-channel/desktop-status.json` and shows the most important state across all visible profiles.

## User Behavior

- The helper is macOS-only. Linux and Windows never start it.
- `lark-channel-bridge run --no-floating-ball` disables it for the current foreground run.
- `lark-channel-bridge start --no-floating-ball` writes the launchd service so that daemon run also disables it.
- A profile can disable it persistently:

```json
{
  "desktop": {
    "floatingBall": {
      "enabled": false
    }
  }
}
```

When the config is missing, macOS treats the feature as enabled. The CLI flag wins over config. Non-macOS platforms are always disabled.

## Snapshot Contract

The bridge writes one aggregate snapshot with a whitelist-only schema:

```json
{
  "updatedAt": "2026-07-12T10:00:00.000Z",
  "aggregateStatus": "tool_running",
  "profiles": [
    {
      "profile": "codex-dev",
      "botName": "Ops Bot",
      "appIdSuffix": "abc123",
      "agent": "codex",
      "status": "tool_running",
      "activeRunCount": 1,
      "queuedMessageCount": 0,
      "updatedAt": "2026-07-12T10:00:00.000Z",
      "lastErrorKind": "agent"
    }
  ]
}
```

Status priority is:

```text
error > reconnecting > tool_running > streaming > thinking > queued > idle > connecting > offline
```

The snapshot must not include message bodies, prompts, assistant output, tool input/output, chat IDs, thread IDs, session IDs, sender IDs, app secrets, tokens, or full app IDs.

## Helper Development

The helper is a SwiftPM AppKit executable at `desktop/macos-floating-ball`.

```bash
cd desktop/macos-floating-ball
swift build -c release
LARK_CHANNEL_FLOATING_BALL_HELPER="$PWD/.build/release/LarkChannelFloatingBall" lark-channel-bridge run
```

The helper is single-instance per `LARK_CHANNEL_HOME`, polls the snapshot as a fallback to file events, saves drag position to `desktop-floating-ball.json`, and clamps restored or expanded windows into the current screen visible frame.
