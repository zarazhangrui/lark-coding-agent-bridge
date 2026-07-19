#!/usr/bin/env python3
"""Stop hook: Claude finished a turn (idle). Optional notification."""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import is_muted, load_config, log, truncate, truncate_body  # noqa: E402
import async_send  # noqa: E402
import registry  # noqa: E402


def _last_assistant_text(transcript_path: str) -> str:
    """Pluck the last assistant message text from the JSONL transcript."""
    try:
        with open(transcript_path) as fh:
            lines = fh.readlines()
    except Exception:  # noqa: BLE001
        return ""
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        # Claude Code transcript format varies; try common shapes.
        msg = entry.get("message") or entry
        role = msg.get("role") or entry.get("type")
        if role not in ("assistant", "ai"):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "text":
                    return blk.get("text", "")
        return ""
    return ""


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log("hook.stop.parse_fail", err=str(e))
        return 0

    cfg = load_config()
    if not cfg["notifications"].get("onStop", True):
        return 0
    if payload.get("stop_hook_active"):
        # Already inside a stop-triggered loop; bail to avoid recursion.
        return 0

    session_id = payload.get("session_id") or ""
    transcript_path = payload.get("transcript_path") or ""

    # Dedup state: which assistant text did we LAST report for this session?
    # If Stop fires again but transcript hasn't been updated with the new
    # response yet, we must NOT resend the previous tail under a new "已完成".
    import hashlib
    import time as _t
    state_path = os.path.join(os.path.dirname(__file__), "..", "logs",
                              ".last_stop.json")
    try:
        state = json.load(open(state_path)) if os.path.exists(state_path) else {}
    except Exception:  # noqa: BLE001
        state = {}

    def _h(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:12]

    prev_hash = state.get(session_id, "")
    last = _last_assistant_text(transcript_path)
    # Retry up to ~5s if (empty) OR (same content as last time we reported).
    # Claude Code writes the assistant message to transcript JSONL with a few
    # seconds of lag after Stop fires; without this we'd return the previous
    # turn's tail.
    for _ in range(8):
        if last and _h(last) != prev_hash:
            break
        _t.sleep(0.6)
        last = _last_assistant_text(transcript_path)

    wid = registry.heartbeat(session_id, "Stop", truncate(last, 200))
    if not wid:
        return 0
    if is_muted(session_id=session_id, window_id=wid):
        log("hook.stop.muted", windowId=wid, tail=truncate(last, 60))
        return 0
    cur_hash = _h(last) if last else ""
    if cur_hash and cur_hash == prev_hash:
        # Same content as last time we reported for this session. Either Stop
        # double-fired, or transcript still hasn't caught up after 5s of retry.
        # Either way, sending would just duplicate the previous "已完成". Skip.
        log("hook.stop.skipped_duplicate", windowId=wid,
            sessionId=session_id[:8], tail=truncate(last, 60))
        return 0
    state[session_id] = cur_hash
    try:
        json.dump(state, open(state_path, "w"))
    except Exception:  # noqa: BLE001
        pass

    title = f"✅ [{wid}] 已完成"
    body = truncate_body(last) or "(无文本输出)"
    async_send.dispatch_card(title, body, "green", wid, "Stop")
    log("hook.stop.dispatched", windowId=wid, tail=truncate(last, 60))
    return 0


if __name__ == "__main__":
    sys.exit(main())
