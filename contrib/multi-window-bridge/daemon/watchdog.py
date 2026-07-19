#!/usr/bin/env python3
"""Watchdog: catches hung Claude sessions that hooks couldn't notify about.

Algorithm (each tick):
  1. Read registry
  2. Prune entries whose claudePid is dead → log eviction (do not notify, hooks
     would have already sent Stop / SessionEnd; if they didn't, the user already
     closed the terminal so no signal needed).
  3. For each surviving window:
     - if (now - lastHookAt) > staleThresholdSeconds
       AND (now - lastWatchdogAlertAt) > rearmAfterAlertSeconds
       → send feishu "疑似卡死", stamp lastWatchdogAlertAt
"""
from __future__ import annotations

import os
import signal
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import file_lock, is_muted, load_config, log, now_ts  # noqa: E402
import feishu  # noqa: E402
import registry  # noqa: E402

_RUN = True


def _stop(_signum, _frame) -> None:  # noqa: ANN001
    global _RUN
    _RUN = False


def _tick(cfg: dict) -> None:
    wd_cfg = cfg["watchdog"]
    stale = wd_cfg["staleThresholdSeconds"]
    notify_on_watchdog = cfg["notifications"].get("onWatchdog", True)

    # Snapshot under lock — but we send feishu *outside* the lock to avoid I/O hold.
    with file_lock(registry.REGISTRY_PATH):
        data = registry._read()
        evicted = registry._prune_dead(data)
        if evicted:
            registry._atomic_write(data)
            log("watchdog.evicted", windowIds=evicted)
        snapshot = {wid: dict(e) for wid, e in data["windows"].items()}

    now = now_ts()
    for wid, entry in snapshot.items():
        last_hook = entry.get("lastHookAt", 0)
        last_alerted_hook = entry.get("lastAlertedHookAt", 0)
        age = now - last_hook
        if age < stale:
            continue
        # Edge-trigger: only alert ONCE per "stale period". We've already alerted
        # for this lastHookAt — don't repeat until the session shows life (new
        # heartbeat → lastHookAt advances → we'd alert if it goes stale again).
        if last_hook <= last_alerted_hook:
            continue
        if not notify_on_watchdog:
            registry.update_watchdog_state(wid, last_alerted_hook_at=last_hook)
            continue
        if is_muted(session_id=entry.get("sessionId", ""), window_id=wid):
            registry.update_watchdog_state(wid, last_alerted_hook_at=last_hook)
            log("watchdog.muted", windowId=wid)
            continue
        cwd = entry.get("cwd", "?")
        last_kind = entry.get("lastHookKind", "?")
        title = f"⚠️ [{wid}] 疑似卡死"
        body = (
            f"📁 `{cwd}`\n\n"
            f"⏱ 最后活动 **{age // 60} 分钟前** (事件: `{last_kind}`)\n"
            f"💀 PID `{entry.get('claudePid')}` 仍存活但未触发任何 hook\n\n"
            f"_(同一卡死只提醒这一次。session 若恢复活动再卡死,会再提醒)_"
        )
        msg_id = feishu.send_card(title, body, color="red")
        if msg_id:
            registry.record_notification(msg_id, wid, "Watchdog")
        registry.update_watchdog_state(wid, last_alerted_hook_at=last_hook)
        log("watchdog.alert", windowId=wid, ageMin=age // 60, msgId=msg_id)


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log("watchdog.boot", pid=os.getpid())
    while _RUN:
        try:
            cfg = load_config()
            _tick(cfg)
        except Exception as e:  # noqa: BLE001
            log("watchdog.tick.error", err=str(e))
        interval = max(10, load_config()["watchdog"]["intervalSeconds"])
        # sleep in 1s slices so SIGTERM is responsive
        for _ in range(interval):
            if not _RUN:
                break
            time.sleep(1)
    log("watchdog.exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
