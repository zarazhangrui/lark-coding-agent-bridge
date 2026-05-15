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
- One of the supported coding-agent CLIs, installed and logged in:
  - `claude` (Claude Code) — see https://docs.anthropic.com/en/docs/claude-code/quickstart  *(default)*
  - `codex` (OpenAI Codex CLI) — `codex login` to authenticate
- A Lark / Feishu **PersonalAgent** app (the QR-code wizard on first launch can create one for you).

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

### Bridging Codex instead of Claude

Run two bots side-by-side (one per agent) with separate data dirs and separate Lark apps:

```bash
# original Claude bot — ~/.lark-channel/, agent=claude
lark-channel-bridge start            # or: start --claude

# second bot wired to Codex — ~/.lark-codex/, agent=codex
lark-channel-bridge start --codex
```

`--codex` auto-uses `~/.lark-codex/config.json`, fires the QR-code wizard on first run so you can bind a **second** PersonalAgent app, and persists `preferences.agent = "codex"` into that config. Both processes use the same `processes.json` mechanism, so `lark-channel-bridge ps` lists them both. Sessions, workspaces, logs, and media cache stay fully isolated between the two data dirs.

For a fully custom location, `-c <path>` still works: the data dir is `dirname(path)`. You can combine `-c` with `--codex` if you want a non-default codex install (`-c` wins on path, `--codex` still writes the agent preference).

> Codex 0.128 does not emit incremental text tokens on `exec --json`, so the card content updates once per turn rather than typewriter-style. Tool-call panels (`command_execution` / `file_change`) still render incrementally.

## Commands

### Host CLI

```
lark-channel-bridge start [-c <config>] [--claude|--codex]   Start the bot
lark-channel-bridge ps                                       List all running start processes on this machine
lark-channel-bridge stop <id|#>                              Stop a start process (SIGTERM, SIGKILL after 2s)
lark-channel-bridge --help                                   List all commands
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

## FAQ

**The bot stays silent / Claude never replies.** Usually the `claude` CLI itself is not logged in, or the session points to a cwd that no longer exists. Send `/status` to inspect; `/new` to start a fresh session.

**Claude subprocess looks frozen (card stuck on the last frame).** Since 0.1.20 there's an idle watchdog: if Claude emits nothing for N minutes the process is killed and the card is annotated `⏱ N min no response, auto-terminated`. Disabled by default. Enable with `/config` (global, in minutes), or `/timeout 10` to set it on the current session; `/timeout off` disables for the session; `/timeout default` clears the session override.

**Claude says it can't see the image I sent.** Upgrade to the latest version — releases before 0.1.0 had a filename-dedup bug.

## License

[MIT](./LICENSE)