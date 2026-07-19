"""Shared helpers: config loader, JSON file lock, logging.

Stdlib-only. All paths anchor at MWB_HOME (~/.claude/multi-window-bridge).
"""
from __future__ import annotations

import contextlib
import datetime
import fcntl
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterator

# (lark_session_ids cache is module-level state defined below)

MWB_HOME = Path.home() / ".claude" / "multi-window-bridge"
CONFIG_PATH = MWB_HOME / "config" / "config.json"
REGISTRY_PATH = MWB_HOME / "registry.json"
LOG_DIR = MWB_HOME / "logs"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open() as fh:
        return json.load(fh)


@contextlib.contextmanager
def file_lock(path: Path, timeout: float = 5.0) -> Iterator[None]:
    """Advisory exclusive lock on a sibling .lock file. Blocks up to timeout."""
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.touch(exist_ok=True)
    deadline = time.monotonic() + timeout
    fd = os.open(lock_path, os.O_RDWR)
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"could not lock {lock_path} within {timeout}s")
                time.sleep(0.05)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def log(kind: str, **fields: Any) -> None:
    """Append a JSONL line to today's log file. Never raises on log errors."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"{datetime.date.today().isoformat()}.log"
        rec = {"ts": time.time(), "kind": kind, **fields}
        with path.open("a") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001 — logs must never break callers
        try:
            sys.stderr.write(f"[mwb log error] {e}\n")
        except Exception:
            pass


def now_ts() -> int:
    return int(time.time())


def truncate(s: str | None, n: int = 240) -> str:
    """Single-line truncate for LOG entries. Replaces newlines with ⏎."""
    if not s:
        return ""
    s = s.strip().replace("\r", " ").replace("\n", " ⏎ ")
    return s if len(s) <= n else s[: n - 1] + "…"


_LARK_SESSIONS_CACHE: dict[str, Any] = {"ts": 0.0, "ids": set()}


def lark_session_ids() -> set[str]:
    """Read ~/.lark-channel/sessions.json and return all sessionIds.

    Cached for 30s to avoid disk hit on every hook fire. Returns empty set on
    any error (missing file / parse fail).
    """
    now = time.time()
    if now - _LARK_SESSIONS_CACHE["ts"] < 30 and _LARK_SESSIONS_CACHE["ids"]:
        return _LARK_SESSIONS_CACHE["ids"]
    path = Path.home() / ".lark-channel" / "sessions.json"
    ids: set[str] = set()
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            for v in data.values():
                sid = v.get("sessionId") if isinstance(v, dict) else None
                if sid:
                    ids.add(sid)
    except Exception:  # noqa: BLE001
        pass
    _LARK_SESSIONS_CACHE["ts"] = now
    _LARK_SESSIONS_CACHE["ids"] = ids
    return ids


def is_muted(session_id: str = "", window_id: str = "") -> bool:
    """Should we suppress feishu dispatch for this session/window?

    Two mute sources merge:
    - notifications.muteWindowIds: explicit list (e.g. user's main chat tab)
    - notifications.muteLarkChannelSessions: auto-mute any session that
      lark-channel-bridge claims (avoids double-feishu when bot spawns claude)
    """
    cfg = load_config()
    nc = cfg.get("notifications", {})
    if window_id and window_id in nc.get("muteWindowIds", []):
        return True
    if session_id and nc.get("muteLarkChannelSessions", True):
        if session_id in lark_session_ids():
            return True
    return False


def truncate_body(s: str | None, n: int = 4000) -> str:
    """Truncate for MESSAGE BODY. Preserves newlines so markdown renders.

    Default 4000 chars. Feishu interactive cards allow up to ~30000 in a
    single markdown element, but anything past 4000 starts hurting readability
    on phone. When truncated, append a footer telling the user how much was
    cut, so they know to grep the transcript for the full version.
    """
    if not s:
        return ""
    s = s.strip().replace("\r", "")
    if len(s) <= n:
        return s
    omitted = len(s) - n
    return s[: n - 1] + f"\n\n… (还有 {omitted} 字省略,完整内容看终端)"
