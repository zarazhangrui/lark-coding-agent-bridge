# lark-channel-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local CLI coding agent. Run one command, scan a QR code to bind a Lark app, and talk to Claude Code or Codex from chat — read screenshots, edit code, anything you'd do at the terminal.

[中文 README](./README.zh.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## What it does

- Forwards Feishu / Lark messages (DM directly, or `@bot` in a group) to your local `claude` or `codex` CLI, running in a working directory you control.
- **Streaming card**: agent text and tool calls update on a single Lark card in real time — no waiting for the final reply.
- **Per-chat sessions**: each chat keeps its own agent session, so conversations resume where they left off.
- **Preempt + batch**: a new message interrupts the running run; rapid-fire messages get coalesced into one request.
- **Multiple workspaces**: `/ws` switches between named project directories, with sessions tracked per workspace.
- **Images and files**: send them to the bot directly — the agent reads the locally downloaded paths.
- **Interactive cards**: `/help`, `/ws list`, `/status` return cards with buttons you can click.

## Prerequisites

- Node.js **>= 20**
- One supported coding-agent CLI installed and logged in:
  - `claude` (Claude Code) — see https://docs.anthropic.com/en/docs/claude-code/quickstart
  - `codex` (OpenAI Codex CLI) — run `codex login`
- A Lark / Feishu **PersonalAgent** app (the QR-code wizard on first launch can create one for you).

## Install

```bash
npm i -g lark-channel-bridge
# or
pnpm add -g lark-channel-bridge
```

## First run

```bash
lark-channel-bridge run
```

The first run detects there's no app configured and **opens a QR-code wizard**:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. Credentials are written to `~/.lark-channel/config.json`.

### Bridging Codex Instead Of Claude

Use `--codex` to bind a separate PersonalAgent app and data directory:

```bash
lark-channel-bridge run --codex
```

Codex mode uses `~/.lark-codex/config.json` by default and persists `preferences.agent = "codex"` into that config. Claude remains the default and continues using `~/.lark-channel/config.json`.

You can also reuse an existing config, including `~/.lark-channel/config.json`, by passing `-c`:

```bash
lark-channel-bridge run -c ~/.lark-channel/config.json --codex
```

That switches the selected config to Codex by writing `preferences.agent = "codex"`. Sessions are tagged by agent, so Codex will not try to resume old Claude sessions from the same `sessions.json`.

Codex CLI currently emits final assistant text as a whole `agent_message` on `codex exec --json`, so text appears once per turn instead of token-by-token. Tool-call panels still update from Codex JSONL events.

## Commands

### Host CLI

**Process-level** (run the bridge directly in your shell):

```
lark-channel-bridge run [-c <config>] [--claude|--codex]      Run the bot in the foreground
lark-channel-bridge ps [-c <config>] [--claude|--codex]       List running bridge processes
lark-channel-bridge kill <id|#> [--claude|--codex]            Kill a bridge process
lark-channel-bridge --help                List all commands
```

**Service-level** (run the bridge as a background OS-managed daemon):

> ⚠️ **Install globally before using service-level commands**. The daemon's launchd plist / systemd unit / Windows task hard-codes the path to the bridge CLI; if you invoke via `npx lark-channel-bridge start`, that path lives in npm's temp cache (`~/.npm/_npx/<hash>/...`) and will be garbage-collected — your daemon stops working as soon as the cache is cleaned. Use `npm install -g lark-channel-bridge` first, then run `lark-channel-bridge start`. `bridge run` is fine via npx (one-shot process).

```
lark-channel-bridge start [--claude|--codex]       Install (if needed) and start the daemon
lark-channel-bridge stop [--claude|--codex]        Stop the daemon and disable autostart
lark-channel-bridge restart [--claude|--codex]     Restart the daemon in place
lark-channel-bridge status [--claude|--codex]      Show daemon status (pid, log paths, last exit)
lark-channel-bridge unregister [--claude|--codex]  Remove the service definition and stop
```

The daemon auto-restarts on crash and on user login. Platform mapping:
- **macOS** → `launchd` user agent at `~/Library/LaunchAgents/ai.lark-channel-bridge.bot.plist`
- **Linux** → `systemd` user unit at `~/.config/systemd/user/lark-channel-bridge.bot.service`. For the daemon to survive logout, run `loginctl enable-linger $USER` once.
- **Windows** → Task Scheduler task `LarkChannelBridge.Bot`, triggered ONLOGON. Launcher script at `~/.lark-channel/daemon-launcher.cmd`.

Daemon logs go to the selected data directory, for example `~/.lark-channel/logs/daemon-stdout.log` for Claude or `~/.lark-codex/logs/daemon-stdout.log` for Codex.

Service registration is still one OS service name (`lark-channel-bridge.bot`). `start --codex` switches that service to Codex mode; it does not register a second daemon beside the Claude daemon.

> When the same app is started multiple times, Lark's open platform routes events to one of the live WebSocket connections at random. `run` detects existing processes for the same app and (in a TTY) prompts: `[c]ontinue / [k]ill old / [a]bort`. In non-TTY mode it warns and continues.

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
| `/doctor [description]` | Feed recent logs and your description back to the agent for self-diagnosis |
| `/help` | Help card |
| Any other `/xxx` | Forwarded verbatim to the active agent |

**Reply policy**: in a DM, the bot replies to anything. In a **group (including topic groups), the bot only replies when `@`-mentioned** (default since 0.1.22); unmentioned messages are ignored. `@all` is never answered. Cloud-doc comments must mention the bot. To restore the older "always answer in groups" behaviour: `/config` → "Require @bot in groups" → No.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Claude app credentials (App ID / Secret), mode 600 |
| `~/.lark-codex/config.json` | Codex app credentials when using `--codex`, mode 600 |
| `~/.lark-channel/sessions.json` | Agent session id + cwd per chat / topic (+ optional `/timeout` override) |
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

**The bot stays silent / agent never replies.** Usually the selected CLI itself is not logged in, or the session points to a cwd that no longer exists. Send `/status` to inspect; `/new` to start a fresh session.

**Agent subprocess looks frozen (card stuck on the last frame).** Since 0.1.20 there's an idle watchdog: if the agent emits nothing for N minutes the process is killed and the card is annotated `⏱ N min no response, auto-terminated`. Disabled by default. Enable with `/config` (global, in minutes), or `/timeout 10` to set it on the current session; `/timeout off` disables for the session; `/timeout default` clears the session override.

**The agent says it can't see the image I sent.** Upgrade to the latest version — releases before 0.1.0 had a filename-dedup bug.

## License

[MIT](./LICENSE)
