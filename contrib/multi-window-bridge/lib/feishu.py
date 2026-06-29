"""Feishu (Lark) client — stdlib HTTP, reads creds from lark-channel-bridge.

We do NOT modify lark-channel-bridge; we only read its config.json to share
app_id / app_secret. We hit the Open API directly for /im/v1/messages.
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from common import MWB_HOME, load_config, log

TOKEN_CACHE = MWB_HOME / ".tenant_token.json"
OPEN_API = "https://open.feishu.cn/open-apis"


def _resolve_secret(c: dict, secret_ref: Any) -> str:
    """Resolve app_secret which may be a plain string OR an exec-provider object.

    0.1.27- format: "secret": "abc123..."
    0.1.28+ format: "secret": {"source": "exec", "provider": "bridge", "id": "app-cli_xxx"}
        — needs to call the provider's command (e.g. lark-channel-bridge secrets get)
        — protocol: stdin {"protocolVersion":1,"ids":[id]} → stdout {"values":{id:secret}}
    """
    if isinstance(secret_ref, str):
        return secret_ref
    if not isinstance(secret_ref, dict) or secret_ref.get("source") != "exec":
        raise ValueError(f"unsupported app.secret format: {secret_ref!r}")
    provider_name = secret_ref["provider"]
    secret_id = secret_ref["id"]
    provider = c.get("secrets", {}).get("providers", {}).get(provider_name)
    if not provider or provider.get("source") != "exec":
        raise ValueError(f"provider {provider_name!r} missing or not exec-type")
    cmd = [provider["command"], *provider.get("args", [])]
    req = json.dumps({"protocolVersion": 1, "ids": [secret_id]}).encode()
    proc = subprocess.run(cmd, input=req, capture_output=True, timeout=10)
    if proc.returncode != 0:
        raise RuntimeError(f"secrets-getter exit {proc.returncode}: {proc.stderr.decode()[:200]}")
    resp = json.loads(proc.stdout)
    val = resp.get("values", {}).get(secret_id)
    if not val:
        raise RuntimeError(f"secrets-getter returned no value for {secret_id!r}: {proc.stdout.decode()[:200]}")
    return val


def _read_creds() -> tuple[str, str]:
    cfg = load_config()
    cred_path = Path(cfg["feishu"]["credentialFile"]).expanduser()
    with cred_path.open() as fh:
        c = json.load(fh)
    app = c["accounts"]["app"]
    return app["id"], _resolve_secret(c, app["secret"])


def _http(method: str, path: str, payload: dict | None = None,
          token: str | None = None, query: dict | None = None,
          timeout: float = 8.0) -> dict[str, Any]:
    url = f"{OPEN_API}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(payload).encode() if payload else None
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"code": -1, "msg": f"http {e.code}: {body[:200]}"}
    except Exception as e:  # noqa: BLE001
        return {"code": -1, "msg": f"network: {e}"}


def _get_token() -> str | None:
    # cached?
    try:
        if TOKEN_CACHE.exists():
            cache = json.loads(TOKEN_CACHE.read_text())
            if cache.get("expiresAt", 0) - 60 > time.time():
                return cache["token"]
    except Exception:  # noqa: BLE001
        pass
    app_id, app_secret = _read_creds()
    resp = _http("POST", "/auth/v3/tenant_access_token/internal",
                 payload={"app_id": app_id, "app_secret": app_secret})
    if resp.get("code") != 0:
        log("feishu.token.fail", resp=resp)
        return None
    token = resp["tenant_access_token"]
    expires_in = resp.get("expire", 7200)
    try:
        TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_CACHE.write_text(json.dumps({"token": token, "expiresAt": time.time() + expires_in}))
    except Exception:  # noqa: BLE001
        pass
    return token


def send_text(text: str, chat_id: str | None = None) -> str | None:
    """Send a plain-text message. Returns Feishu message_id or None on failure."""
    cfg = load_config()
    chat_id = chat_id or cfg["feishu"]["chatId"]
    token = _get_token()
    if not token:
        log("feishu.send.no_token")
        return None
    resp = _http(
        "POST",
        "/im/v1/messages",
        query={"receive_id_type": "chat_id"},
        token=token,
        payload={
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        },
    )
    if resp.get("code") != 0:
        log("feishu.send.fail", resp=resp, text_head=text[:80])
        return None
    return resp.get("data", {}).get("message_id")


def send_card(title: str, body: str, color: str = "default",
              chat_id: str | None = None) -> str | None:
    """Send a Feishu interactive card with markdown body.

    color: header template — "green" / "blue" / "yellow" / "red" / "default".
           Maps to Feishu's built-in palette.
    body: markdown — supports **bold**, `code`, lists, line breaks, etc.
    """
    cfg = load_config()
    chat_id = chat_id or cfg["feishu"]["chatId"]
    token = _get_token()
    if not token:
        log("feishu.send.no_token")
        return None
    card = {
        "config": {"wide_screen_mode": True, "enable_forward": True},
        "header": {
            "template": color,
            "title": {"tag": "plain_text", "content": title},
        },
        "elements": [
            {"tag": "markdown", "content": body or "(无内容)"},
        ],
    }
    resp = _http(
        "POST",
        "/im/v1/messages",
        query={"receive_id_type": "chat_id"},
        token=token,
        payload={
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        },
    )
    if resp.get("code") != 0:
        log("feishu.send_card.fail", resp=resp, title=title[:80])
        return None
    return resp.get("data", {}).get("message_id")


def create_group(name: str, member_open_ids: list[str],
                 description: str = "") -> str | None:
    """Create a feishu group chat with the bot + given users. Returns chat_id or None.

    The bot calling this API is automatically the owner/member of the new chat.
    member_open_ids gets added alongside.
    """
    token = _get_token()
    if not token:
        log("feishu.create_group.no_token")
        return None
    payload = {
        "name": name,
        "description": description,
        "chat_mode": "group",
        "chat_type": "private",
        "external": False,
        "user_id_list": member_open_ids,
    }
    resp = _http(
        "POST",
        "/im/v1/chats",
        query={"user_id_type": "open_id", "set_bot_manager": "true"},
        token=token,
        payload=payload,
    )
    if resp.get("code") != 0:
        log("feishu.create_group.fail", resp=resp, name=name)
        return None
    chat_id = resp.get("data", {}).get("chat_id")
    log("feishu.create_group.ok", name=name, chatId=chat_id)
    return chat_id


def update_group(chat_id: str, name: str | None = None,
                 description: str | None = None) -> bool:
    """Update a group's name/description. Returns True on success."""
    token = _get_token()
    if not token:
        log("feishu.update_group.no_token")
        return False
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if description is not None:
        payload["description"] = description
    if not payload:
        return True
    resp = _http("PUT", f"/im/v1/chats/{chat_id}", token=token, payload=payload)
    if resp.get("code") != 0:
        log("feishu.update_group.fail", resp=resp, chatId=chat_id, name=name)
        return False
    log("feishu.update_group.ok", chatId=chat_id, name=name)
    return True


def list_chat_messages(chat_id: str, start_time: int | None = None,
                       page_size: int = 20) -> list[dict[str, Any]]:
    """List recent messages from a chat. start_time is unix seconds (inclusive)."""
    token = _get_token()
    if not token:
        return []
    query: dict[str, Any] = {
        "container_id_type": "chat",
        "container_id": chat_id,
        "sort_type": "ByCreateTimeDesc",
        "page_size": page_size,
    }
    if start_time:
        query["start_time"] = str(start_time)
    resp = _http("GET", "/im/v1/messages", query=query, token=token)
    if resp.get("code") != 0:
        log("feishu.list.fail", resp=resp)
        return []
    return resp.get("data", {}).get("items", []) or []


def get_message(message_id: str) -> dict[str, Any] | None:
    token = _get_token()
    if not token:
        return None
    resp = _http("GET", f"/im/v1/messages/{message_id}", token=token)
    if resp.get("code") != 0:
        return None
    items = resp.get("data", {}).get("items", [])
    return items[0] if items else None
