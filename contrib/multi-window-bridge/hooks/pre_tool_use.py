#!/usr/bin/env python3
"""PreToolUse hook: tool is about to run. Notify on sensitive tools.

We DO NOT block (exit 0 always). The point is observability, not policy.

Note: Under defaultMode=allow / bypassPermissions, Claude does NOT actually
prompt the user for tool approval. So this hook fires as an FYI ("Claude is
about to run X") rather than an auth request. The notification copy reflects
that.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import is_muted, load_config, log, truncate, truncate_body  # noqa: E402
import async_send  # noqa: E402
import registry  # noqa: E402


def _summarize_tool(tool: str, ti: dict) -> tuple[str, str, str]:
    """Returns (title_suffix, body_markdown, color) for a tool call."""
    if tool == "Bash":
        cmd = ti.get("command", "")
        return ("即将执行 Bash", f"```bash\n{cmd}\n```", "blue")
    if tool == "Edit":
        fp = ti.get("file_path", "?")
        old = ti.get("old_string", "")
        new = ti.get("new_string", "")
        diff = ""
        if old or new:
            diff = f"\n\n```diff\n- {old[:200]}\n+ {new[:200]}\n```"
        return ("即将编辑文件", f"📄 `{fp}`{diff}", "blue")
    if tool == "Write":
        fp = ti.get("file_path", "?")
        content_head = (ti.get("content", "") or "")[:200]
        preview = f"\n\n```\n{content_head}\n```" if content_head else ""
        return ("即将写文件", f"📄 `{fp}`{preview}", "blue")
    if tool == "NotebookEdit":
        nb = ti.get("notebook_path", "?")
        cell = ti.get("cell_id", "?")
        return ("即将改 notebook", f"📓 `{nb}` (cell `{cell}`)", "blue")
    if tool == "AskUserQuestion":
        # Special UX: Claude is asking the user a multi-choice question.
        qs = ti.get("questions") or []
        if not qs:
            return ("Claude 想问你", "(没有问题内容)", "yellow")
        parts = []
        for q in qs:
            qtext = q.get("question", "")
            opts = q.get("options", [])
            parts.append(f"**{qtext}**\n")
            for i, opt in enumerate(opts, 1):
                label = opt.get("label", "")
                desc = opt.get("description", "")
                parts.append(f"{i}. **{label}** — {desc}")
            parts.append("")  # blank line between questions
        return ("Claude 想问你", "\n".join(parts), "yellow")
    return (f"即将执行 {tool}",
            f"```json\n{json.dumps(ti, ensure_ascii=False, indent=2)[:600]}\n```",
            "blue")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log("hook.pretool.parse_fail", err=str(e))
        return 0

    session_id = payload.get("session_id") or ""
    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}

    cfg = load_config()
    notify_cfg = cfg["notifications"]

    # Always heartbeat (proves session alive for watchdog) BEFORE any return.
    registry.heartbeat(session_id, "PreToolUse", f"{tool}")

    # AskUserQuestion = 真正的"需要用户确认",任何模式都发。
    # Bash / Edit / Write / NotebookEdit = "执行过程",受 mode 控制。
    is_user_attention = (tool == "AskUserQuestion")
    if not is_user_attention:
        # Mode quiet (默认) → 不发"执行过程"通知
        mode = notify_cfg.get("mode", "quiet")
        if mode == "quiet":
            return 0
        # Mode verbose → 还要看老的 onToolAuth + toolAuthIncludes 细控
        if not notify_cfg.get("onToolAuth", False):
            return 0
        allow = notify_cfg.get("toolAuthIncludes", ["Bash", "Edit", "Write"])
        if tool not in allow:
            return 0

    # Build the notification payload (title suffix / body / color) from the call.
    title_suffix, body, color = _summarize_tool(tool, ti)
    icon = "🟡" if is_user_attention else "🔧"

    wid = registry.heartbeat(session_id, "PreToolUse",
                             f"{tool}: {truncate(body, 200)}")
    if not wid:
        return 0
    if is_muted(session_id=session_id, window_id=wid):
        log("hook.pretool.muted", windowId=wid, tool=tool)
        return 0
    title = f"{icon} [{wid}] {title_suffix}"
    async_send.dispatch_card(title, truncate_body(body, 1200), color,
                             wid, "PreToolUse")
    log("hook.pretool.dispatched", windowId=wid, tool=tool,
        summary=truncate(body, 80))
    return 0


if __name__ == "__main__":
    sys.exit(main())
