"""Per-window feishu chat mapping.

State file: ~/.claude/multi-window-bridge/session_chats.json
{
  "windowChats": {
    "<windowId>": {
      "chatId": "oc_xxx",
      "cwd": "/Users/you/sandbox",
      "groupName": "claude · sandbox-7819 · sandbox",
      "createdAt": 1779513491
    }
  }
}

Lookup is by windowId since mwb's identity unit is the window (registry.py).
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from common import MWB_HOME, log

STATE_PATH = MWB_HOME / "session_chats.json"


def _read() -> dict:
    if not STATE_PATH.exists():
        return {"windowChats": {}}
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception as e:  # noqa: BLE001
        log("session_chats.read_fail", err=str(e))
        return {"windowChats": {}}


def _atomic_write(data: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".session_chats.", suffix=".tmp",
                                dir=str(STATE_PATH.parent))
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_PATH)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def get_chat_for_window(window_id: str) -> str | None:
    """Return chat_id for this window, or None if not yet mapped."""
    data = _read()
    entry = data.get("windowChats", {}).get(window_id)
    return entry.get("chatId") if entry else None


def set_chat_for_window(window_id: str, chat_id: str, cwd: str,
                         group_name: str) -> None:
    """Store the mapping. Caller has already created the group via feishu API."""
    data = _read()
    data.setdefault("windowChats", {})[window_id] = {
        "chatId": chat_id,
        "cwd": cwd,
        "groupName": group_name,
        "createdAt": int(time.time()),
    }
    _atomic_write(data)


def list_all() -> dict:
    """Return the full windowChats map (for /mwb-list integration etc)."""
    return _read().get("windowChats", {})
