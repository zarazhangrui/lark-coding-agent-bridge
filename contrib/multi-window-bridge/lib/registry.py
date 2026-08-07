"""Registry: maps window-id → {claudePid, sessionId, cwd, lastHookAt, ...}.

Lives at ~/.claude/multi-window-bridge/registry.json. Atomic R/W with flock.
"""
from __future__ import annotations

import json
import os
import re
import signal
from pathlib import Path
from typing import Any

from common import REGISTRY_PATH, file_lock, log, now_ts

MAX_NOTIF_HISTORY = 200


def _empty() -> dict[str, Any]:
    return {"version": 1, "windows": {}, "notifications": {}}


def _read() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return _empty()
    try:
        with REGISTRY_PATH.open() as fh:
            data = json.load(fh)
        if "windows" not in data:
            return _empty()
        return data
    except json.JSONDecodeError:
        log("registry.corrupt", path=str(REGISTRY_PATH))
        return _empty()


def _atomic_write(data: dict[str, Any]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_PATH.with_suffix(".json.tmp")
    with tmp.open("w") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, REGISTRY_PATH)


def _next_window_id(data: dict[str, Any], cwd: str, alias: str | None,
                    claude_pid: int = 0) -> str:
    if alias:
        # User-supplied: use as-is (sanitized), append -2/-3 on collision
        clean = re.sub(r"[^a-zA-Z0-9_\-]", "-", alias).strip("-") or "window"
        existing = set(data["windows"].keys())
        if clean not in existing:
            return clean
        n = 2
        while f"{clean}-{n}" in existing:
            n += 1
        return f"{clean}-{n}"
    # Auto-name: {basename}-{pid_last4} so multiple home-dir sessions disambiguate
    # (e.g. "you-3736" + "you-7476") AND so any feishu alert lets the
    # user `pgrep` and find the offending Claude immediately.
    base = Path(cwd).name or "root"
    base = re.sub(r"[^a-zA-Z0-9_\-]", "-", base).strip("-") or "root"
    pid_suffix = str(claude_pid)[-4:].rjust(4, "0") if claude_pid else "0000"
    candidate = f"{base}-{pid_suffix}"
    existing = set(data["windows"].keys())
    if candidate not in existing:
        return candidate
    # Pathological pid recycling: append numeric tail
    n = 2
    while f"{candidate}-{n}" in existing:
        n += 1
    return f"{candidate}-{n}"


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but not ours; treat as alive


def _prune_dead(data: dict[str, Any]) -> list[str]:
    """Remove windows whose claudePid is dead. Returns evicted ids."""
    evicted = []
    for wid, entry in list(data["windows"].items()):
        pid = entry.get("claudePid", -1)
        if not _pid_alive(pid):
            evicted.append(wid)
            del data["windows"][wid]
    return evicted


# ── public API ─────────────────────────────────────────────────────────────

def register(session_id: str, cwd: str, claude_pid: int, transcript_path: str,
             alias: str | None) -> str:
    """Create / refresh entry for a Claude session. Returns window-id."""
    with file_lock(REGISTRY_PATH):
        data = _read()
        _prune_dead(data)
        # If session_id already known, reuse window-id.
        for wid, entry in data["windows"].items():
            if entry.get("sessionId") == session_id:
                entry["claudePid"] = claude_pid
                entry["transcriptPath"] = transcript_path
                entry["lastHookAt"] = now_ts()
                entry["lastHookKind"] = "SessionStart"
                _atomic_write(data)
                return wid
        wid = _next_window_id(data, cwd, alias, claude_pid)
        data["windows"][wid] = {
            "alias": alias or wid,
            "cwd": cwd,
            "claudePid": claude_pid,
            "sessionId": session_id,
            "transcriptPath": transcript_path,
            "startedAt": now_ts(),
            "lastHookAt": now_ts(),
            "lastHookKind": "SessionStart",
            "lastHookSummary": "",
            "registeredManually": bool(alias),
            "lastWatchdogAlertAt": 0,
        }
        _atomic_write(data)
        return wid


def heartbeat(session_id: str, kind: str, summary: str = "") -> str | None:
    """Update lastHookAt/kind for the window matching session_id. Returns window-id or None."""
    with file_lock(REGISTRY_PATH):
        data = _read()
        for wid, entry in data["windows"].items():
            if entry.get("sessionId") == session_id:
                entry["lastHookAt"] = now_ts()
                entry["lastHookKind"] = kind
                entry["lastHookSummary"] = summary
                _atomic_write(data)
                return wid
        return None


def unregister(session_id: str) -> str | None:
    with file_lock(REGISTRY_PATH):
        data = _read()
        for wid, entry in list(data["windows"].items()):
            if entry.get("sessionId") == session_id:
                del data["windows"][wid]
                _atomic_write(data)
                return wid
        return None


def lookup_by_window_id(window_id: str) -> dict[str, Any] | None:
    data = _read()
    return data["windows"].get(window_id)


def list_windows() -> dict[str, dict[str, Any]]:
    return _read()["windows"]


def record_notification(message_id: str, window_id: str, kind: str) -> None:
    if not message_id:
        return
    with file_lock(REGISTRY_PATH):
        data = _read()
        notifs = data.setdefault("notifications", {})
        notifs[message_id] = {"windowId": window_id, "kind": kind, "sentAt": now_ts()}
        # FIFO trim
        if len(notifs) > MAX_NOTIF_HISTORY:
            for k in list(notifs.keys())[: len(notifs) - MAX_NOTIF_HISTORY]:
                del notifs[k]
        _atomic_write(data)


def find_window_for_notification(message_id: str) -> str | None:
    data = _read()
    rec = data.get("notifications", {}).get(message_id)
    return rec["windowId"] if rec else None


def update_watchdog_state(window_id: str,
                          last_alerted_hook_at: int = 0) -> None:
    """Stamp watchdog alert state.

    `last_alerted_hook_at`: the lastHookAt value at the time of this alert.
    Watchdog uses it for edge-trigger logic — only fire again if lastHookAt
    advances past this value (i.e., the session showed signs of life since
    the previous alert).
    """
    with file_lock(REGISTRY_PATH):
        data = _read()
        if window_id in data["windows"]:
            data["windows"][window_id]["lastWatchdogAlertAt"] = now_ts()
            if last_alerted_hook_at:
                data["windows"][window_id]["lastAlertedHookAt"] = last_alerted_hook_at
            _atomic_write(data)


def kill_window_pid(window_id: str) -> tuple[bool, str]:
    """SIGTERM the claudePid for window_id. Returns (ok, message)."""
    entry = lookup_by_window_id(window_id)
    if not entry:
        return False, f"no such window: {window_id}"
    pid = entry.get("claudePid", -1)
    if not _pid_alive(pid):
        return True, f"pid {pid} already dead"
    try:
        os.kill(pid, signal.SIGTERM)
        return True, f"sent SIGTERM to pid {pid}"
    except Exception as e:  # noqa: BLE001
        return False, f"kill {pid} failed: {e}"
