#!/usr/bin/env python3
"""SessionEnd hook: remove window from registry."""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import log  # noqa: E402
import registry  # noqa: E402


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log("hook.session_end.parse_fail", err=str(e))
        return 0
    session_id = payload.get("session_id") or ""
    reason = payload.get("reason") or "unknown"
    wid = registry.unregister(session_id)
    log("hook.session_end", windowId=wid, sessionId=session_id[:8], reason=reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
