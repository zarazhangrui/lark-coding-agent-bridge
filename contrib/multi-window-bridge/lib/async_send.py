"""Fire-and-forget feishu sender for hooks.

Why: Claude Code enforces a per-hook timeout (5-8s in our settings.json). The
first feishu API call after token cache cold-start can take 10-30s due to
network conditions. If we send synchronously, the hook gets SIGKILL'd before
logging anything, and the user sees nothing.

Solution: hook calls dispatch_*() which spawns a fully-detached subprocess.
The subprocess does the actual send + logs result. The hook returns in <50ms.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

MWB_ROOT = Path(__file__).resolve().parent.parent
WORKER = MWB_ROOT / "lib" / "send_worker.py"


def _spawn(payload: dict, window_id: str, kind: str) -> None:
    """Spawn detached worker. Never raises."""
    try:
        p = subprocess.Popen(
            [sys.executable, str(WORKER), window_id, kind],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        if p.stdin:
            p.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            p.stdin.close()
    except Exception:
        pass


def dispatch_text(text: str, window_id: str, kind: str) -> None:
    """Send a plain-text message (no card)."""
    _spawn({"mode": "text", "text": text}, window_id, kind)


def dispatch_card(title: str, body: str, color: str,
                  window_id: str, kind: str) -> None:
    """Send a markdown-rendered interactive card."""
    _spawn({"mode": "card", "title": title, "body": body, "color": color},
           window_id, kind)


# Back-compat alias (old hooks may still call .dispatch)
dispatch = dispatch_text
