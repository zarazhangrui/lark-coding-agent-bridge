# lark-channel-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local Claude Code CLI. Run one command, scan a QR code to bind a Lark app, and talk to Claude from chat — read screenshots, edit code, anything you'd do at the terminal.

[中文 README](./README.zh.md)

## What it does

- Forwards Feishu / Lark messages (DM directly, or `@bot` in a group) to your local `claude` CLI, running in a working directory you control.
- **Streaming card**: Claude's text and tool calls update on a single Lark card in real time — no waiting for the final reply.
- **Per-chat sessions**: each chat keeps its own Claude session, so conversations resume where they left off.
- **Preempt + batch**: a new message interrupts the running run; rapid-fire messages get coalesced into one request.
- **Multiple workspaces**: `/ws` switches between named project directories, with sessions tracked per workspace.
- **Images and files**: send them to the bot directly — Claude reads the locally downloaded paths.
- **Interactive cards**: `/help`, `/ws list`, `/status` return cards with buttons you can click.

## Prerequisites

- Node.js **>= 20**
- `claude` CLI (default) or `coco` CLI (internal) installed and logged in.
- A Lark / Feishu **PersonalAgent** app (the QR-code wizard on first launch can create one for you).


## Agent Backends

The bridge supports switching between different backend CLIs to run the conversation:

| Backend | CLI | Description |
|---------|-----|-------------|
| `claude` (default) | `claude` | The official [Anthropic Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/quickstart) |
| `coco` | `coco` | ByteDance internal **Trae CLI** — the coding agent shipped with [Trae IDE](https://www.trae.ai/) / Marscode, exposed as a standalone CLI named `coco` |

### What is Coco?

**Coco** is the CLI version of Trae AI (formerly Marscode), ByteDance's AI coding assistant. It provides the same agentic capabilities as the Trae IDE extension — code generation, editing, shell commands, file operations — but runs headlessly in a terminal, making it ideal for use behind this bridge.

Key characteristics:
- Streams structured JSON events (similar to Claude Code's `--output-format stream-json`)
- Supports `--yolo` mode for auto-accepting edits
- Supports session resumption via `--resume <session_id>`
- Available internally at ByteDance; external users should use `claude` backend

### Installing Coco

```bash
# Internal: install via company package manager
tnpm i -g @anthropic/traecli
# or download from internal release page

# Verify installation
coco --version
```

> If your `coco` binary is installed at a non-standard path or named differently, you can specify `cocoBinary` in config (see below).

### Switching to Coco Backend

Edit `~/.lark-channel/config.json`:

```json
{
  "preferences": {
    "agentBackend": "coco",
    "cocoBinary": "/path/to/coco"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `agentBackend` | Yes | Set to `"coco"` to use Coco backend |
| `cocoBinary` | No | Absolute path to the `coco` binary. Defaults to `"coco"` (looks up `/Users/rambo/.local/bin:/Users/rambo/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/opt/go/libexec/bin:/Users/rambo/go/bin:/Users/rambo/Library/pnpm:/Users/rambo/Library/Python/3.9/bin:/opt/homebrew/opt/mysql-client/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/usr/local/go/bin:/opt/puppetlabs/bin:/Users/rambo/.aime_pc/bin:/usr/local/sbin`) |

Then restart the bridge:

```bash
# Stop the running instance
lark-channel-bridge stop 1
# Start again
lark-channel-bridge start
```

### Verifying Coco Backend is Active

After starting the bridge with `agentBackend: "coco"`:

1. **Check startup log** — terminal should print:
   ```
   [INFO] Using backend: coco
   ```
   If you see `✗ 未找到 coco CLI`, the binary path is wrong or coco is not installed.

2. **Send `/status` in Feishu** — the response card shows the active backend type.

3. **Send any message** — watch the terminal; you should see `spawn` logs with `adapter: "coco"`.

### Coco vs Claude: Behavioral Differences

| Aspect | claude | coco |
|--------|--------|------|
| Permission mode | `--dangerously-skip-permissions` | `--yolo` |
| Session resume | `--resume <id>` | `--resume <id>` |
| Output format | `--output-format stream-json` | `--output-format stream-json` |
| System prompt | bridge injects lark-channel conventions | same |
| Availability | Public (anyone with Anthropic account) | Internal (ByteDance) |

## Install

```bash
npm i -g lark-channel-bridge
# or
pnpm add -g lark-channel-bridge
```

## First run

```bash
lark-channel-bridge start
```

The first run detects there's no app configured and **opens a QR-code wizard**:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. Credentials are written to `~/.lark-channel/config.json`.

### Granting scopes and event subscriptions

The wizard creates the app shell, but you still need to confirm a few things on the Lark Developer Console:

**Permission scopes:**
- `im:message`
- `im:message:send_as_bot`
- `im:resource`

**Event subscriptions (over long-lived WebSocket):**
- `im.message.receive_v1`
- `card.action.trigger`
- `im.message.reaction.created_v1` / `deleted_v1` (optional)
- `im.chat.member.bot.added_v1` (optional)

After enabling those, run `lark-channel-bridge start` again. Once you see `✓ Connected`, find the bot in Feishu / Lark and start chatting.

## Commands

### Host CLI

```
lark-channel-bridge start [-c <config>]   Start the bot
lark-channel-bridge ps                    List all running start processes on this machine
lark-channel-bridge stop <id|#>           Stop a start process (SIGTERM, SIGKILL after 2s)
lark-channel-bridge --help                List all commands
```

> When the same app is started multiple times, Lark's open platform routes events to one of the live WebSocket connections at random. `start` detects existing processes for the same app and (in a TTY) prompts: `[c]ontinue / [k]ill old / [a]bort`. In non-TTY mode it warns and continues.

`status` / `doctor` / `handover` / `workspace` / `service` are placeholders, planned for later releases.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current chat's session |
| `/cd <path>` | Switch working directory (resets session) |
| `/ws list` | List named workspaces (card + buttons) |
| `/ws save <name>` | Save current cwd as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/status` | Current cwd / session / agent (card + buttons) |
| `/config` | Adjust preferences (reply style, tool-call display, ...) |
| `/stop` | Stop the run in progress (also the `⏹` button on the card) |
| `/timeout [N\|off\|default]` | Idle-watchdog (minutes) for the current session. `/config` sets the global default. See FAQ below. |
| `/ps` | List all `start` processes on this host, marking the one replying |
| `/exit <id\|#>` | Stop a `start` process (your own → graceful; another's → SIGTERM) |
| `/reconnect` | Force a WebSocket reconnect (use when the bot stops responding after a network blip) |
| `/doctor [description]` | Feed recent logs and your description back to Claude for self-diagnosis |
| `/help` | Help card |
| Any other `/xxx` | Forwarded verbatim to Claude |

**Reply policy**: in a DM, the bot replies to anything. In a **group (including topic groups), the bot only replies when `@`-mentioned** (default since 0.1.22); unmentioned messages are ignored. `@all` is never answered. Cloud-doc comments must mention the bot. To restore the older "always answer in groups" behaviour: `/config` → "Require @bot in groups" → No.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | App credentials (App ID / Secret), mode 600 |
| `~/.lark-channel/sessions.json` | Claude session id + cwd per chat / topic (+ optional `/timeout` override) |
| `~/.lark-channel/workspaces.json` | Named-workspace map |
| `~/.lark-channel/processes.json` | Process registry for live `start` instances (used by `ps`/`stop`); dead PIDs are auto-pruned |
| `~/.lark-channel/media/<chatId>/` | Downloaded images / files, cleaned up after 24h |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | Structured run logs (JSONL), rotated daily; older than 7 days are pruned at startup (`LARK_CHANNEL_LOG_DAYS` env var overrides). `/doctor` reads these. |

> Upgrading from before 0.1.11? Run `lark-channel-bridge migrate` once — it moves anything under `~/.config/lark-channel-bridge/` and `~/.cache/lark-channel-bridge/` to the new location and upgrades `config.json` to the new schema.

## Access control (optional)

Out of the box the bot is **open**: anyone who can find it can DM it, any group member can `@`-mention it to trigger a run, and commands like `/account` or `/cd` are usable by all. **That's fine for personal use** — but for a shared team setup, or anywhere you don't want strangers calling `/cd /`, you can tighten three allowlists by sending `/config` inside Feishu.

### Common scenarios

**Just me**

In the `/config` form:
- **Allowed users**: your own `open_id`
- Leave the other two blank

Messages from anyone else are silently dropped — no denial reply, since that would just confirm the bot exists to outsiders.

**A small team**

- **Allowed users**: comma-separated `open_id`s of team members
- Other two blank

**Bot only responds in specific work groups**

DMs are unaffected; only listed groups trigger responses:
- **Allowed chats**: comma-separated `chat_id`s of the groups
- DMs are **always** exempt from this list — so you can always DM the bot to change config later.

**Anyone can chat with the bot, but only I can change settings**

- **Admins**: your own `open_id`
- Other two blank

Others running `/account`, `/config`, `/exit`, `/reconnect`, `/doctor`, `/cd`, or `/ws` get a `❌ 此命令仅管理员可用` reply. Normal conversation (asking the bot to do things) is unaffected.

**Lock everything down**

Fill all three. The `/config` form catches common mistakes — e.g. if your admin list doesn't include yourself, or your chat allowlist doesn't include the chat you're submitting from, the submit is rejected with a message explaining why, so you can't accidentally lock yourself out.

### Finding `open_id` and `chat_id`

Easiest path: have the target user send the bot a message (or `@`-mention it in the target group), then in your terminal:

```bash
grep '"event":"enter"' ~/.lark-channel/logs/$(date +%Y-%m-%d).log | tail -5
```

Every line carries `chatId` (group or DM id) and `senderId` (the user's `open_id`). Copy them from there.

The Feishu open-platform "Get user info" API also works but needs the `contact:user` scope, which is overkill if you just need a couple of IDs.

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- An empty field means **unrestricted**, not "nobody allowed".
- To revert a restricted list back to fully open, clear that field in `/config` and submit.
- DMs are deliberately exempt from the chat allowlist — meaning if you ever accidentally restrict the bot out of every group, **DM the bot and send `/config`** to recover.

### Advanced: editing the config file directly

The `/config` form writes to `~/.lark-channel/config.json` under `preferences.access`:

```json
{
  "preferences": {
    "agentBackend": "coco",
    "access": {
      "allowedUsers": ["ou_xxxxxxxxxxxxx"],
      "allowedChats": ["oc_xxxxxxxxxxxxx"],
      "admins":       ["ou_xxxxxxxxxxxxx"]
    }
  }
}
```

After a manual edit, **restart the bridge** or send **`/reconnect`** from any allowed chat to pick up the changes. The form is usually faster; direct edits make sense mostly for deployment scripts where you want to pre-seed access policy.

## FAQ

**The bot stays silent / Claude never replies.** Usually the `claude` CLI itself is not logged in, or the session points to a cwd that no longer exists. Send `/status` to inspect; `/new` to start a fresh session.

**Claude subprocess looks frozen (card stuck on the last frame).** Since 0.1.20 there's an idle watchdog: if Claude emits nothing for N minutes the process is killed and the card is annotated `⏱ N min no response, auto-terminated`. Disabled by default. Enable with `/config` (global, in minutes), or `/timeout 10` to set it on the current session; `/timeout off` disables for the session; `/timeout default` clears the session override.

**Claude says it can't see the image I sent.** Upgrade to the latest version — releases before 0.1.0 had a filename-dedup bug.

## License

[MIT](./LICENSE)