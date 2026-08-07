"""Receiver: poll the configured Feishu chat for replies, route by window_id.

Reply protocols supported (in priority order):
  1. **Prefix tag**: text body starts with `[window-id]` or `window-id:`
     e.g.  `[kb-1] 继续干`  /  `kb-1: 继续干`
  2. **Quote reply**: user quotes a notification we sent — Feishu API surfaces
     the parent message_id; we look it up in registry.notifications.
  3. Plain text with NO tag is ignored (avoids stealing messages destined for
     lark-channel-bridge, which is also listening on the same chat).

State (persisted at MWB/.receiver_state.json):
  { "lastSeenTs": <unix>, "processedIds": [<recent msg_ids, capped 200>] }
"""
from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import MWB_HOME, load_config, log, now_ts  # noqa: E402
import feishu  # noqa: E402
import registry  # noqa: E402
import router  # noqa: E402

STATE_PATH = MWB_HOME / ".receiver_state.json"

PREFIX_RE = re.compile(r"^\s*[\[【]\s*([A-Za-z0-9_\-]{1,60})\s*[\]】](!?)\s*(.+)$", re.DOTALL)
COLON_RE = re.compile(r"^\s*([A-Za-z0-9_\-]{1,60})(!?)\s*[:：]\s*(.+)$", re.DOTALL)

_RUN = True


def _stop(_s, _f) -> None:  # noqa: ANN001
    global _RUN
    _RUN = False


def _load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:  # noqa: BLE001
            pass
    return {"lastSeenTs": now_ts() - 60, "processedIds": []}


def _save_state(state: dict) -> None:
    state["processedIds"] = state["processedIds"][-200:]
    STATE_PATH.write_text(json.dumps(state))


def _extract_text(msg: dict) -> str:
    """Pluck plain text from a Feishu message envelope."""
    body = msg.get("body", {})
    content = body.get("content", "")
    if not content:
        return ""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return ""
    if msg.get("msg_type") == "text":
        return parsed.get("text", "")
    if msg.get("msg_type") == "post":
        # Rich text — pull all text segments
        out = []
        for line in parsed.get("zh_cn", {}).get("content", []) or parsed.get("en_us", {}).get("content", []) or []:
            for seg in line:
                if seg.get("tag") == "text":
                    out.append(seg.get("text", ""))
        return " ".join(out)
    return ""


def _parse_reply(text: str) -> tuple[str, bool, str] | None:
    """Returns (window_id, force_bypass_guard, reply_text) or None."""
    for rx in (PREFIX_RE, COLON_RE):
        m = rx.match(text)
        if m:
            return m.group(1), m.group(2) == "!", m.group(3).strip()
    return None


def _quoted_parent_id(msg: dict) -> str | None:
    upper = msg.get("upper_message_id")
    if upper:
        return upper
    parent = msg.get("parent_id")
    return parent or None


def _tick(cfg: dict, state: dict) -> None:
    chat_id = cfg["feishu"]["chatId"]
    since = max(state["lastSeenTs"] - 5, now_ts() - 24 * 3600)  # safety floor
    items = feishu.list_chat_messages(chat_id, start_time=since, page_size=20)
    # Feishu returns desc by create time; process oldest first.
    items = list(reversed(items))
    processed_set = set(state["processedIds"])
    for msg in items:
        mid = msg.get("message_id", "")
        if not mid or mid in processed_set:
            continue
        # Skip messages sent BY the bot itself (sender is app)
        sender_type = msg.get("sender", {}).get("sender_type")
        if sender_type == "app":
            state["processedIds"].append(mid)
            continue
        text = _extract_text(msg)
        if not text:
            state["processedIds"].append(mid)
            continue

        window_id = None
        reply = None
        force = False

        parsed = _parse_reply(text)
        if parsed:
            window_id, force, reply = parsed
            if not registry.lookup_by_window_id(window_id):
                window_id = None

        if not window_id:
            parent_id = _quoted_parent_id(msg)
            if parent_id:
                wid = registry.find_window_for_notification(parent_id)
                if wid:
                    window_id = wid
                    reply = text.strip()
                    # Quote-reply path: no `!` syntax, default no force.
                    force = False

        if not window_id:
            log("receiver.ignore", mid=mid, head=text[:60])
            state["processedIds"].append(mid)
            continue

        log("receiver.route", mid=mid, windowId=window_id, force=force,
            head=(reply or "")[:60])
        try:
            result = router.route(window_id, reply or "", force=force)
            log("receiver.route.done", mid=mid, windowId=window_id, result=result)
        except Exception as e:  # noqa: BLE001
            log("receiver.route.err", mid=mid, err=str(e))
        state["processedIds"].append(mid)

    # Advance the time floor only as far as the most recent message we saw.
    if items:
        latest = items[-1]
        ct = latest.get("create_time")
        if ct:
            try:
                state["lastSeenTs"] = int(int(ct) / 1000)
            except (ValueError, TypeError):
                pass
    state["lastSeenTs"] = max(state["lastSeenTs"], now_ts() - 3600)

    # Drain pending queue: any windows that are now idle get their queued
    # replies auto-fired. This is Option B (auto-continue after Claude finishes).
    _drain_pending()


IDLE_KINDS = ("Stop", "Notification", "SessionStart")


def _drain_pending() -> None:
    pending = router.list_pending()
    for wid, items in list(pending.items()):
        if not items:
            continue
        entry = registry.lookup_by_window_id(wid)
        if not entry:
            # Window is gone (claude died / session ended). Drop pending.
            router.clear_pending(wid)
            log("drain.window_gone", windowId=wid, dropped=len(items))
            continue
        last_kind = entry.get("lastHookKind", "")
        if last_kind not in IDLE_KINDS:
            # Still busy. Skip; next tick will retry.
            continue
        text = router.pop_pending(wid)
        if not text:
            continue
        log("drain.firing", windowId=wid, head=text[:60])
        try:
            result = router.route(wid, text, force=True)
            log("drain.fired", windowId=wid, result=result)
        except Exception as e:  # noqa: BLE001
            log("drain.err", windowId=wid, err=str(e))
            # Re-queue at head so we retry next tick
            router.add_pending(wid, text)


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log("receiver.boot", pid=os.getpid())
    state = _load_state()
    while _RUN:
        try:
            cfg = load_config()
            if not cfg["stage2"]["enabled"]:
                # Stay alive but idle so launchd doesn't crash-loop us.
                time.sleep(30)
                continue
            _tick(cfg, state)
            _save_state(state)
        except Exception as e:  # noqa: BLE001
            log("receiver.tick.err", err=str(e))
        interval = max(10, load_config()["stage2"]["pollIntervalSeconds"])
        for _ in range(interval):
            if not _RUN:
                break
            time.sleep(1)
    log("receiver.exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
