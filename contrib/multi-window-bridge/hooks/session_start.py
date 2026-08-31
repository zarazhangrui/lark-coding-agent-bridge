#!/usr/bin/env python3
"""SessionStart hook: register window in MWB registry.

Stdin (Claude Code v1.x):
  { "session_id": ..., "cwd": ..., "transcript_path": ..., "source": "startup|resume|...", ... }

We register {session_id → window_id} using env MWB_WINDOW_ALIAS if set.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import log, load_config  # noqa: E402
import registry  # noqa: E402
import session_chats  # noqa: E402


def _spawn_group_create(window_id: str, cwd: str) -> None:
    """Spawn detached group-create worker. Never raises."""
    try:
        worker = os.path.join(os.path.dirname(__file__), "..", "lib",
                               "group_create_worker.py")
        subprocess.Popen(
            [sys.executable, worker, window_id, cwd],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except Exception as e:  # noqa: BLE001
        log("hook.session_start.group_spawn_fail", err=str(e))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log("hook.session_start.parse_fail", err=str(e))
        return 0

    session_id = payload.get("session_id") or ""
    cwd = payload.get("cwd") or os.getcwd()
    transcript_path = payload.get("transcript_path") or ""
    source = payload.get("source") or "unknown"
    if not session_id:
        return 0

    alias = os.environ.get("MWB_WINDOW_ALIAS")
    claude_pid = os.getppid()  # parent of hook is claude process

    wid = None
    try:
        wid = registry.register(
            session_id=session_id,
            cwd=cwd,
            claude_pid=claude_pid,
            transcript_path=transcript_path,
            alias=alias,
        )
        log("hook.session_start", windowId=wid, sessionId=session_id[:8],
            cwd=cwd, source=source, pid=claude_pid, alias=alias)
    except Exception as e:  # noqa: BLE001
        log("hook.session_start.fail", err=str(e))

    # Per-window-group: kick off async group creation if not yet mapped.
    # No-ops if perWindowGroups.enabled=false OR mapping already exists.
    if wid:
        try:
            cfg = load_config()
            pwg = cfg.get("feishu", {}).get("perWindowGroups", {})
            if pwg.get("enabled") and not session_chats.get_chat_for_window(wid):
                _spawn_group_create(wid, cwd)
        except Exception as e:  # noqa: BLE001
            log("hook.session_start.group_check_fail", err=str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
