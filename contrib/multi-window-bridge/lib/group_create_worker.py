#!/usr/bin/env python3
"""Detached worker: create a feishu group for a window if one doesn't exist yet.

Invocation:
  group_create_worker.py <windowId> <cwd>

Runs free of any hook timeout. Idempotent — if windowId already has a mapping,
no-ops. Otherwise creates the group via feishu API + adds the user from
config.feishu.userOpenId + saves the mapping.

Logs result via common.log.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import load_config, log  # noqa: E402
import feishu  # noqa: E402
import session_chats  # noqa: E402


def _cwd_base(cwd: str) -> str:
    """Render cwd for group name. Home directory → '~' (avoid redundant username).

    Examples:
      /Users/you           → ~
      /Users/you/sandbox   → sandbox
      /private/tmp/foo          → foo
      /                         → /
    """
    home = str(Path.home())
    if cwd == home:
        return "~"
    return Path(cwd).name or "/"


def main() -> int:
    if len(sys.argv) < 3:
        log("group_create_worker.bad_args", argv=sys.argv)
        return 2
    window_id = sys.argv[1]
    cwd = sys.argv[2]

    cfg = load_config()
    feishu_cfg = cfg.get("feishu", {})
    pwg = feishu_cfg.get("perWindowGroups", {})
    if not pwg.get("enabled"):
        log("group_create.skipped_disabled", windowId=window_id)
        return 0

    # Idempotency: already mapped?
    existing = session_chats.get_chat_for_window(window_id)
    if existing:
        log("group_create.skipped_exists", windowId=window_id, chatId=existing)
        return 0

    user_open_id = feishu_cfg.get("userOpenId")
    if not user_open_id:
        log("group_create.no_user_open_id")
        return 1

    template = pwg.get("groupNameTemplate", "claude · {windowId} · {cwdBase}")
    name = template.format(windowId=window_id, cwdBase=_cwd_base(cwd), cwd=cwd)

    chat_id = feishu.create_group(
        name=name,
        member_open_ids=[user_open_id],
        description=f"Auto-created by mwb for window {window_id} (cwd: {cwd})",
    )
    if not chat_id:
        log("group_create.api_fail", windowId=window_id, name=name)
        return 1

    session_chats.set_chat_for_window(window_id, chat_id, cwd, name)
    log("group_create.ok", windowId=window_id, chatId=chat_id, name=name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
