"""Router: given a (window_id, reply_text), resume the session in a new Warp tab.

Strategy (Stage 2, Method A):
  0. **Probe**: can osascript control Warp? If not → bail BEFORE killing.
  1. Look up registry entry for window_id → sessionId + claudePid
  2. **Busy guard**: refuse if Claude is mid-task (unless force=True)
  3. SIGTERM old pid (so two `claude` processes don't fight over session.jsonl)
  4. Put reply_text on the macOS clipboard
  5. AppleScript: activate Warp → Cmd+T → type `claude --resume <sid>` → Enter
  6. If allowAppleScriptPaste: Cmd+V + Enter; else user pastes manually

A queue at MWB/pending.json holds replies that were refused (busy / no perm).
The receiver daemon drains the queue when Claude transitions back to idle.
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from common import MWB_HOME, file_lock, load_config, log  # noqa: E402
import feishu  # noqa: E402
import registry  # noqa: E402
import json  # noqa: E402

PENDING_PATH = MWB_HOME / "pending.json"


def _load_pending() -> dict:
    if PENDING_PATH.exists():
        try:
            return json.loads(PENDING_PATH.read_text())
        except Exception:  # noqa: BLE001
            pass
    return {}


def _save_pending(data: dict) -> None:
    PENDING_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def add_pending(wid: str, text: str) -> int:
    """Queue a reply for later auto-fire when window goes idle."""
    with file_lock(PENDING_PATH):
        p = _load_pending()
        p.setdefault(wid, []).append({"text": text, "savedAt": int(time.time())})
        _save_pending(p)
        return len(p[wid])


def pop_pending(wid: str) -> str | None:
    with file_lock(PENDING_PATH):
        p = _load_pending()
        items = p.get(wid, [])
        if not items:
            return None
        item = items.pop(0)
        if not items:
            del p[wid]
        _save_pending(p)
        return item["text"]


def clear_pending(wid: str) -> int:
    with file_lock(PENDING_PATH):
        p = _load_pending()
        n = len(p.get(wid, []))
        if wid in p:
            del p[wid]
        _save_pending(p)
        return n


def list_pending() -> dict:
    return _load_pending()


def _pbcopy(text: str) -> bool:
    try:
        p = subprocess.Popen(["/usr/bin/pbcopy"], stdin=subprocess.PIPE)
        p.communicate(text.encode("utf-8"))
        return p.returncode == 0
    except Exception as e:  # noqa: BLE001
        log("router.pbcopy.fail", err=str(e))
        return False


def _osascript(script: str) -> tuple[int, str]:
    try:
        r = subprocess.run(
            ["/usr/bin/osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode, (r.stderr or r.stdout).strip()
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def probe_applescript() -> tuple[bool, str]:
    """Return (ok, diagnostic). Verifies osascript can both 'tell Warp' and
    drive System Events keystrokes — both Automation and Accessibility perms.
    """
    # Test Automation perm (tell Warp)
    rc, out = _osascript('tell application "Warp" to return name as string')
    if rc != 0:
        return False, f"automation: {out[:200]}"
    # Test Accessibility perm (System Events keystrokes — innocuous probe)
    rc, out = _osascript('tell application "System Events" to return name of first process')
    if rc != 0:
        return False, f"accessibility: {out[:200]}"
    return True, "ok"


def _open_warp_tab_and_run(command: str, auto_paste_text: str | None) -> tuple[bool, str]:
    """Open a fresh Warp tab, type `command`, press Enter.

    If auto_paste_text is non-None, after 2.5s also Cmd+V + Enter.
    Both stages need Accessibility permission for `osascript` (System Settings →
    Privacy & Security → Accessibility → enable for osascript / Terminal /
    whoever ran this).
    """
    # AppleScript-quote: backslashes + double quotes
    cmd_q = command.replace("\\", "\\\\").replace('"', '\\"')
    script = (
        'tell application "Warp" to activate\n'
        'delay 0.3\n'
        'tell application "System Events"\n'
        '    keystroke "t" using {command down}\n'
        '    delay 0.6\n'
        f'    keystroke "{cmd_q}"\n'
        '    key code 36\n'  # Enter
        'end tell\n'
    )
    rc, out = _osascript(script)
    if rc != 0:
        return False, f"osascript phase1 rc={rc}: {out}"
    if auto_paste_text is not None:
        if not _pbcopy(auto_paste_text):
            return True, "tab opened but pbcopy failed; please paste manually"
        # Wait longer so Claude TUI is fully booted AND any trust-folder prompt
        # ("Is this a project you trust?") has rendered. The first Enter then
        # accepts the default "Yes, I trust this folder" option if shown, or
        # no-ops in Claude's chat input if not.
        time.sleep(3.5)
        paste_script = (
            'tell application "Warp" to activate\n'
            'tell application "System Events"\n'
            '    -- Step 1: pre-emptively accept any first-time trust prompt\n'
            '    --        (default option is "Yes, I trust this folder")\n'
            '    key code 36\n'
            '    delay 1.0\n'
            '    -- Step 2: paste the actual reply and submit\n'
            '    keystroke "v" using {command down}\n'
            '    delay 0.3\n'
            '    key code 36\n'
            'end tell\n'
        )
        rc2, out2 = _osascript(paste_script)
        if rc2 != 0:
            return True, f"tab opened; auto-paste failed (rc={rc2}: {out2})"
    return True, "ok"


def route(window_id: str, reply_text: str, force: bool = False) -> str:
    """Main entry: returns a human-readable status string for logging / feishu.

    `force=True` bypasses the "Claude is busy mid-task" guard. Set this via
    the `[wid]! ...` syntax from feishu.
    """
    cfg = load_config()
    if not cfg["stage2"]["enabled"]:
        return "stage2 disabled in config"

    entry = registry.lookup_by_window_id(window_id)
    if not entry:
        return f"no such window: {window_id}"

    sid = entry["sessionId"]
    pid = entry.get("claudePid", -1)
    cwd = entry.get("cwd", "~")

    # PRE-FLIGHT: probe osascript permissions BEFORE killing anything.
    # Without Accessibility + Automation perms, we'd kill old Claude and then
    # fail to open a new tab — losing the user's running session.
    ok, why = probe_applescript()
    if not ok:
        _pbcopy(reply_text)
        add_pending(window_id, reply_text)
        feishu.send_card(
            title=f"⚠️ [{window_id}] 自动接管失败 (osascript 没权限)",
            body=(
                f"osascript 不能控制 Warp:\n```\n{why}\n```\n\n"
                f"**原 Claude 进程没动** — 你的会话还活着。\n\n"
                f"## 现在怎么办\n"
                f"你的回复**已复制到剪贴板** + **存到 pending 队列**。\n"
                f"在 Warp 里随便开个新 tab,跑:\n"
                f"```bash\n"
                f"claude --resume {sid}\n"
                f"```\n"
                f"Claude TUI 起来后 **Cmd+V + Enter**。\n\n"
                f"## 一劳永逸:给 osascript 权限\n"
                f"系统设置 → 隐私与安全性 →\n"
                f"- **自动化**: 找到「osascript」,勾上「Warp」+「System Events」\n"
                f"- **辅助功能**: + `/usr/bin/osascript`\n\n"
                f"给完权限后,飞书再发 `[{window_id}]! 重试` 触发一次。"
            ),
            color="red",
        )
        log("router.no_applescript", windowId=window_id, why=why)
        return f"no AppleScript permission: {why}"

    # Safety guard: refuse kill if Claude is mid-task.
    # When Claude calls a tool, lastHookKind transitions to "PreToolUse" and
    # stays there until Stop (turn finished) or a new Notification fires. If
    # we kill mid-tool, the tool's result is lost and the session.jsonl ends
    # up with a tool_use that has no tool_result — Claude on --resume may
    # re-run the tool (waste) or get confused (incorrect state).
    guard = cfg["stage2"].get("guardBusy", True)
    busy_kinds = cfg["stage2"].get("guardBusyKinds", ["PreToolUse"])
    last_kind = entry.get("lastHookKind", "")
    if guard and not force and last_kind in busy_kinds:
        last_at = entry.get("lastHookAt", 0)
        age = max(0, int(time.time()) - last_at)
        summary = entry.get("lastHookSummary", "")
        mins, sec = divmod(age, 60)
        when = f"{mins}分{sec}秒前" if mins else f"{sec}秒前"
        _pbcopy(reply_text)
        feishu.send_card(
            title=f"⏸ [{window_id}] 正在干活,已拒绝接管",
            body=(
                f"上一个事件: `{last_kind}` ({when})\n"
                f"内容: `{summary[:200]}`\n\n"
                f"**强行 kill 可能让任务半截死掉**(Bash 子进程会被一起杀,"
                f"Edit/Write 已落地但 Claude resume 后不知道)。\n\n"
                f"---\n\n"
                f"你的回复已**复制到剪贴板**,可以手动粘到对应 Warp tab。\n\n"
                f"**要强制接管**: 飞书回 `[{window_id}]! 你的话`(加感叹号绕过守卫)"
            ),
            color="yellow",
        )
        add_pending(window_id, reply_text)
        log("router.refused_busy", windowId=window_id,
            lastKind=last_kind, ageSec=age, summary=summary[:80])
        return f"refused: busy ({last_kind}, {age}s ago)"

    # Always copy reply to clipboard so user has a fallback no matter what.
    _pbcopy(reply_text)

    # Decoupled flow (ORDER MATTERS — opening tab BEFORE killing old):
    #
    #   1. Open new Warp tab + run `claude --resume <sid>` [implicitly tests
    #      that keystroke perm works; if not, we still have old Claude alive]
    #   2. If tab open succeeded → kill old PID
    #   3. (After ~2.5s) auto-paste the reply if enabled
    #
    # The OLD ordering (kill → open tab) caused a disaster when the
    # `keystroke` permission was missing: old Claude died but new tab never
    # opened, stranding the user with a dead session.
    cmd = f"cd {shlex.quote(cwd)} && claude --resume {shlex.quote(sid)}"
    auto = reply_text if cfg["stage2"]["allowAppleScriptPaste"] else None
    ok, msg = _open_warp_tab_and_run(cmd, auto)
    log("router.resume", windowId=window_id, ok=ok, msg=msg, autoPaste=bool(auto))

    if not ok:
        # Tab open failed. Old Claude is STILL ALIVE — no damage.
        # Queue the reply so the drain can retry once user fixes perms.
        add_pending(window_id, reply_text)
        feishu.send_card(
            title=f"⚠️ [{window_id}] 接管失败 (原 Claude 没动)",
            body=(
                f"开 Warp tab 失败 — 通常是 `keystroke` 没辅助功能权限:\n"
                f"```\n{msg[:400]}\n```\n\n"
                f"**原 Claude 进程没被杀**,会话完好。\n\n"
                f"## 现在怎么办\n"
                f"你的回复**已复制到剪贴板** + **已存到 pending 队列**。\n\n"
                f"1. 给 osascript 辅助功能权限:\n"
                f"   系统设置 → 隐私与安全性 → **辅助功能** → 找 `osascript` 勾上\n"
                f"   (找不到就 +/usr/bin/osascript)\n"
                f"2. **重启 receiver** 让它拿到新权限:\n"
                f"   `launchctl kickstart -k gui/$(id -u)/com.local.mwb-receiver`\n"
                f"3. pending 队列里你这条会**自动重试**——只要 Claude 是 idle 状态。\n\n"
                f"## 或者手动接管(立刻能用)\n"
                f"在 Warp 里跑:\n```bash\nclaude --resume {sid}\n```\n"
                f"剪贴板里是你的回复,TUI 起来后 Cmd+V + Enter。"
            ),
            color="red",
        )
        return f"⚠️ tab open failed (old Claude untouched): {msg}"

    # Tab opened OK — now safe to kill old.
    if cfg["stage2"]["killOldPidBeforeResume"]:
        kill_ok, kill_msg = registry.kill_window_pid(window_id)
        log("router.kill_old", windowId=window_id, ok=kill_ok, msg=kill_msg)

    # User took control; clear any stale pending for this window.
    clear_pending(window_id)
    if auto is None:
        feishu.send_text(
            f"📲 [{window_id}] 已开新窗口跑 `claude --resume`,"
            f"回复内容已复制到剪贴板。等 TUI 起来后到 Warp 里按 Cmd+V 回车就行。"
        )
    else:
        feishu.send_text(f"📲 [{window_id}] 已开新窗口并自动粘入回复,请在 Warp 里检查。")
    return msg


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: router.py <window_id> <reply_text>")
        sys.exit(2)
    print(route(sys.argv[1], sys.argv[2]))
