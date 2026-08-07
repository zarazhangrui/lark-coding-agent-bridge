#!/usr/bin/env python3
"""Detached worker: reads a JSON payload from stdin, sends via feishu, logs.

Invocation:
  send_worker.py <window_id> <kind>
  stdin = {"mode": "text", "text": "..."}
          OR
          {"mode": "card", "title": "...", "body": "...", "color": "green"}

Runs free of any hook timeout. Logs result so we can audit.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import log, truncate  # noqa: E402
import feishu  # noqa: E402
import registry  # noqa: E402
import session_chats  # noqa: E402


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    window_id = sys.argv[1]
    kind = sys.argv[2]
    kind_lc = {"Notification": "notification", "Stop": "stop",
               "PreToolUse": "pretool"}.get(kind, kind.lower())

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        # Back-compat: treat raw stdin as plain text.
        payload = {"mode": "text", "text": raw}

    # Per-window-group routing: if this window has its own chat, send there.
    # Fall back to default chatId in config (handled inside feishu.send_*).
    per_window_chat = session_chats.get_chat_for_window(window_id)

    mode = payload.get("mode", "text")
    try:
        if mode == "card":
            msg_id = feishu.send_card(
                title=payload.get("title", ""),
                body=payload.get("body", ""),
                color=payload.get("color", "default"),
                chat_id=per_window_chat,
            )
            preview = payload.get("title", "")
        else:
            text = payload.get("text", "")
            msg_id = feishu.send_text(text, chat_id=per_window_chat)
            preview = text
    except Exception as e:  # noqa: BLE001
        log(f"hook.{kind_lc}.fail", windowId=window_id, err=str(e))
        return 1

    if not msg_id:
        log(f"hook.{kind_lc}.send_failed", windowId=window_id)
        return 1
    registry.record_notification(msg_id, window_id, kind)
    log(f"hook.{kind_lc}.sent", windowId=window_id, msgId=msg_id,
        msg=truncate(preview, 80))
    return 0


if __name__ == "__main__":
    sys.exit(main())
