#!/usr/bin/env python3
"""Notification hook: Claude is asking for user input. Push to feishu."""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import is_muted, load_config, log, now_ts, truncate, truncate_body  # noqa: E402
import async_send  # noqa: E402
import registry  # noqa: E402


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log("hook.notification.parse_fail", err=str(e))
        return 0

    session_id = payload.get("session_id") or ""
    message = payload.get("message") or ""
    cwd = payload.get("cwd") or ""

    cfg = load_config()
    if not cfg["notifications"].get("onInput", True):
        return 0

    # Skip generic idle-pings. Claude Code fires Notification both for genuine
    # attention requests (permission prompts, real questions) AND for routine
    # idle-after-Stop ("Claude is waiting for your input"). Under bypassPerms
    # the idle ones add zero info — Stop already told the user we're done. We
    # still heartbeat so watchdog knows the session is alive.
    msg_low = (message or "").strip().lower()
    IDLE_MARKERS = (
        "claude is waiting for your input",
        "claude is waiting",
        "is waiting for your input",
    )
    is_idle = any(m in msg_low for m in IDLE_MARKERS)

    wid = registry.heartbeat(session_id, "Notification", truncate(message, 200))
    if not wid:
        # Window not yet registered (SessionStart may have raced). Skip silently.
        log("hook.notification.no_window", sessionId=session_id[:8])
        return 0

    if is_idle:
        # Heartbeat done (watchdog will know we're alive); don't spam feishu.
        log("hook.notification.skipped_idle", windowId=wid)
        return 0

    if is_muted(session_id=session_id, window_id=wid):
        log("hook.notification.muted", windowId=wid)
        return 0

    # Rate limit per window
    min_interval = cfg["notifications"].get("minIntervalSecondsPerWindow", 5)
    state_path = os.path.join(os.path.dirname(__file__), "..", "logs", ".last_notif.json")
    try:
        state = json.load(open(state_path)) if os.path.exists(state_path) else {}
    except Exception:  # noqa: BLE001
        state = {}
    last = state.get(wid, 0)
    if now_ts() - last < min_interval:
        log("hook.notification.rate_limited", windowId=wid, ageSec=now_ts() - last)
        return 0

    # Stamp rate-limit BEFORE dispatch. Async dispatch can't tell us if send
    # succeeds within hook lifetime, so we optimistically gate further attempts.
    # If the async worker fails it logs hook.notification.send_failed; user can
    # inspect logs but won't see a duplicate flood.
    state[wid] = now_ts()
    try:
        json.dump(state, open(state_path, "w"))
    except Exception:  # noqa: BLE001
        pass
    title = f"🟡 [{wid}] 需要你回复"
    body = f"📁 `{cwd}`\n\n{truncate_body(message, 800)}"
    async_send.dispatch_card(title, body, "yellow", wid, "Notification")
    log("hook.notification.dispatched", windowId=wid, msg=truncate(message, 80))
    return 0


if __name__ == "__main__":
    sys.exit(main())
