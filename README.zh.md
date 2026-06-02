# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code CLI 打通的轻量 bot，用一条命令起服务，扫码绑应用，在飞书里和 Claude 对话、让它读图 / 改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 能干什么

- 在飞书（私聊直接发；群里 `@bot`）把消息转给本地的 `claude` CLI，Claude 在你指定的工作目录里工作
- **流式卡片**：Claude 的文本和工具调用实时出现在同一张卡片上，不用傻等
- **会话延续**：每个 chat 独立 session，对话能接着上次说
- **抢占 + 批处理**：中途发新消息会打断旧任务；快速连发几条会合并成一次请求
- **多工作空间**：`/ws` 切换不同项目，session 自己重置
- **图片 / 文件**：直接发给 bot，Claude 会读本地下载的文件路径
- **卡片按钮**：`/help` `/ws list` `/status` 返回交互卡片，点按钮直接操作
- **按 session 调 reasoning effort**：健身/随口聊天用 `low`，代码/AI 研究用 `xhigh` 或 `max`
- **空回复兜底**：如果 Claude 只产出 thinking / tool call 而没有可见文本，bridge 会显示明确提示并写日志
- **本机 GUI 自动化（可选）**：bridge 启动 Claude 时会挂载 `bridge-mcp.json` 里的 `gui` MCP，可从飞书触发截图、点击、输入等桌面操作

## 前置条件

- Node.js **≥ 20**
- `claude` CLI 已安装并登录：https://docs.anthropic.com/en/docs/claude-code/quickstart
- 一个飞书 / Lark PersonalAgent 应用（首次启动的扫码向导能帮你创建）
- 如果要从飞书触发 GUI 操作：Mac 需要保持唤醒、已登录且相关辅助功能 / 屏幕录制权限已授权

## 安装

```bash
npm i -g lark-channel-bridge
# 或
pnpm add -g lark-channel-bridge
```

## 首次启动

```bash
lark-channel-bridge run
```

第一次跑会检测到没配置应用，**自动进入扫码向导**：

1. 终端渲染一个二维码
2. 用飞书 App 扫码
3. 选择 / 创建 PersonalAgent 应用
4. 成功后凭据写入 `~/.lark-channel/config.json`

## 命令速查

### 宿主 CLI

**进程层**（在你自己的 shell 里直接跑 bridge）:

```
lark-channel-bridge run [-c <config>]     前台启动 bot
lark-channel-bridge ps                    列出本机所有正在跑的 bridge 进程
lark-channel-bridge kill <id|#>           kill 指定 bridge 进程（SIGTERM，2s 后 SIGKILL）
lark-channel-bridge --help                列所有命令
```

**服务层**（让 OS 在后台托管 bridge）:

> ⚠️ **服务层命令必须先全局安装,不能直接用 npx**。daemon 的 launchd plist / systemd unit / Windows 任务里会**硬编码** bridge CLI 的路径;通过 `npx lark-channel-bridge start` 调用时,这条路径在 npm 的临时缓存里(`~/.npm/_npx/<hash>/...`),会被 GC 清掉 — 一旦缓存清理,daemon 就起不来了。请先 `npm install -g lark-channel-bridge`,再 `lark-channel-bridge start`。`bridge run` 用 npx 调用没问题(单次进程)。

```
lark-channel-bridge start                 注册（如需）+ 启动后台 daemon
lark-channel-bridge stop                  停止 daemon 并关闭开机自启
lark-channel-bridge restart               重启 daemon
lark-channel-bridge status                查看 daemon 状态（pid、日志路径、上次退出码）
lark-channel-bridge unregister            撤销注册（停止 + 删除服务定义文件）
```

daemon 崩溃会被自动拉起，用户登录时也会自动启动。平台映射:
- **macOS** → `launchd` 用户代理 `~/Library/LaunchAgents/ai.lark-channel-bridge.bot.plist`
- **Linux** → `systemd` 用户单元 `~/.config/systemd/user/lark-channel-bridge.bot.service`。要让 daemon 在退出登录后还能跑，执行一次 `loginctl enable-linger $USER`。
- **Windows** → Task Scheduler 任务 `LarkChannelBridge.Bot`，触发条件为 ONLOGON。启动脚本位于 `~/.lark-channel/daemon-launcher.cmd`。

daemon 的 stdout / stderr 写到 `~/.lark-channel/logs/daemon-stdout.log` 和 `daemon-stderr.log`，跟 bridge 自己的每日结构化日志放在同一个目录。

> 多开同一个 app 时，开放平台会把事件随机推到其中一个长连接。`run` 启动前会检测同 app 已有的进程，TTY 下提示 `[c]ontinue / [k]ill old / [a]bort` 三选；非 TTY 只 warn 并继续。

### 在飞书里用的斜杠命令

| 命令 | 作用 |
|---|---|
| `/new [effort]` `/reset [effort]` | 清空当前 chat 的会话；可用 `/new low` 新会话同时设低 reasoning |
| `/cd <path>` | 切换工作目录（会重置 session） |
| `/ws list` | 列所有命名工作空间（卡片 + 按钮） |
| `/ws save <name>` | 把当前 cwd 存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/status` | 当前 cwd / session / agent（卡片 + 按钮） |
| `/config` | 调整偏好（消息回复方式、工具调用显示等） |
| `/stop` | 终止当前正在跑的 run（也可点卡片底部 ⏹ 终止 按钮） |
| `/effort [low\|medium\|high\|xhigh\|max\|default]` | 当前 session 的 Claude Code reasoning effort；`extra high` 会映射为 `xhigh`，`ultra` 会映射为 `max` |
| `/timeout [N\|off\|default]` | 当前 session 的 idle 探活（分钟）；`/config` 改全局默认。详见下方"常见问题 — Claude 子进程假死" |
| `/ps` | 列出本机所有 start 进程，标识当前回复的是哪个 |
| `/exit <id\|#>` | 终止指定 start 进程（自己 = graceful 退出；他人 = SIGTERM） |
| `/reconnect` | 强制重连 WebSocket（网络抖动后 bot 没反应时用） |
| `/doctor [描述]` | 把最近运行日志和你的描述喂给 Claude，自助诊断卡住 / 异常的原因 |
| `/help` | 帮助卡片 |
| 其它 `/xxx` | 原样交给 Claude |

**消息策略**：私聊 = 不需要 @，任何消息都回；**群（含话题群）= 默认要 @bot 才回**（0.1.22 起的新默认），不 @ 时 bot 完全沉默；@全员永远不响应；云文档评论必须 @bot。要恢复"群里也不强制 @"的老行为：`/config` → "群里需要 @ bot" → 选"否"。

### Session effort 语义

Claude Code 本机支持的 `--effort` 值是 `low` / `medium` / `high` / `xhigh` / `max`。bridge 额外接受一些口语别名：`extra high` / `extra-high` / `x_high` 会规范化成 `xhigh`，`ultra` / `ultra high` 会规范化成 `max`。

优先级：

1. 当前 chat / topic 的 `/effort` 覆盖优先，写入 `~/.lark-channel/sessions.json`
2. 没有 session 覆盖时，使用 `/config` 表单里的全局默认 `preferences.effort`
3. 全局默认缺失或非法时，回退到 `xhigh`

常用模式：

- `/effort low`：不清空上下文，只让当前 session 后续 run 用低 effort
- `/effort default`：清除当前 session 覆盖，回到全局默认
- `/new low`：在**当前 chat/topic** 里清空 Claude session，并把新 session 设为低 effort
- `/new`：在当前 chat/topic 里清空 Claude session，不指定 effort
- `/new chat [name]`：新建一个飞书群聊。它不是 `/new low`；如果当前 chat 已经有 `/effort` 覆盖，新群会继承这个覆盖

`/status` 会显示当前生效的 effort，并标注来源是 session 覆盖还是全局默认。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 应用凭据（App ID / Secret），权限 600 |
| `~/.lark-channel/sessions.json` | 每个 chat / 话题 的 Claude session id + cwd（+ 可选的 `/timeout` / `/effort` 覆盖） |
| `~/.lark-channel/workspaces.json` | 工作空间映射 |
| `~/.lark-channel/processes.json` | 当前在跑的 start 进程注册中心（`ps`/`stop` 用），死进程会被自动清理 |
| `~/.lark-channel/media/<chatId>/` | 下载的图片 / 文件，24h 自动清理 |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | 结构化运行日志（JSON line），按天滚动；启动时清理超过 7 天的老文件（`LARK_CHANNEL_LOG_DAYS` 环境变量可改）；`/doctor` 命令读它做诊断 |
| `bridge-mcp.json` | bridge 专用 MCP 配置，让 `claude -p` print 模式也能加载本机 GUI 自动化 server |

> 升级自 0.1.11 之前的版本？跑一次 `lark-channel-bridge migrate` —— 自动把 `~/.config/lark-channel-bridge/` 和 `~/.cache/lark-channel-bridge/` 下的内容搬到新位置，并把 `config.json` 升级到新结构。

## GUI 自动化能力

bridge 的 ClaudeAdapter 会在每次 spawn `claude -p` 时追加：

- `--mcp-config /Users/charlesli/code/feishu-claude-code-bridge/bridge-mcp.json`
- 一组 `--allowed-tools mcp__gui__...`

这样从飞书来的 Claude run 可以使用 `gui` MCP 做截图、点击、输入、滚动、读写剪贴板等桌面操作。这个能力适合扫企业微信邮件、操作本地客户端、处理必须靠 GUI 的流程。

运行条件：

- 电脑必须保持系统唤醒，不能 sleep
- 最好保持已登录、未锁屏；锁屏或合盖后 GUI 自动化通常不可靠
- 首次使用可能需要在 macOS 上批准辅助功能和屏幕录制权限
- 目标 app 要在当前用户会话里可见、可操作

安全提醒：GUI MCP 等于允许飞书 allowlist 内的人远程驱动这台 Mac 的屏幕、鼠标和键盘。生产使用前务必配置好 `allowedUsers` / `allowedChats` / `admins`。`bridge-mcp.json` 里的 computer-use 可执行路径带 Codex 插件版本号，Codex 更新后如果路径失效，需要同步更新这个文件并 rebuild/restart。

## 访问控制（可选）

默认 bot 是"开放"的：任何能找到它的人都能私聊它，群里 @bot 就触发响应。**个人自己用 / 给朋友用，这就够了**——但如果想给团队用、或者怕在大群里被滥用，可以在飞书里发 `/config`，调下面三栏中的一栏或几栏。

### 几种典型用法

**只让我自己用**

`/config` 表单里：
- "用户白名单"：填你自己的 `open_id`
- 其它两栏留空

之后非你发的消息会被 bot 静默丢弃——bot 不会回"你没权限"之类的话，免得暴露它存在。

**只让一小群同事用**

- "用户白名单"：填同事们的 `open_id`，英文逗号分隔
- 其它两栏留空

**bot 只在指定工作群里干活**

私聊不受影响；群里只有名单上的群才触发响应：
- "群白名单"：填想让 bot 工作的群 `chat_id`，英文逗号分隔
- 私聊**永远**不受此约束——意味着你随时能 DM bot 调配置

**谁都能跟 bot 聊，但只有我能改设置**

- "管理员"：填你自己的 `open_id`
- 其它两栏留空

下次别人发 `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` 这些敏感命令，会收到 `❌ 此命令仅管理员可用`。普通对话（让 bot 帮忙做事）不受影响。

**完全收紧**

三栏全填。`/config` 表单会拦下常见误配——比如管理员名单里没把你自己加进去、群白名单里没包含当前会话，提交时会被拒绝并提示原因，不会让你不小心把自己锁在外面。

### 怎么找 `open_id` 和 `chat_id`

最快的办法：让目标用户给 bot 发一条任意消息（群的话就 @bot 一下），然后在终端：

```bash
grep '"event":"enter"' ~/.lark-channel/logs/$(date +%Y-%m-%d).log | tail -5
```

每一行都带 `chatId`（= 群或私聊 ID）和 `senderId`（= 用户 `open_id`），照着复制就行。

也可以查飞书开放平台的"获取用户信息"API，但要先给你的应用加 `contact:user` scope，没必要为了几个 ID 折腾。

### 几点提醒

- 改完 `/config` **下一条消息**就生效，不用重启
- 把任何一栏设成**空字符串** = 不限制（不是"一个都不允许"）
- 想从某种受限状态回到"完全开放"，把对应栏目清空再提交即可
- 私聊不受"群白名单"约束——这是设计上故意的：万一你不小心把所有群都锁死了，**回到 bot 的私聊里发 `/config` 就能解锁**

### 高级：直接改配置文件

不太想登飞书也可以，`/config` 表单背后写的是 `~/.lark-channel/config.json` 的 `preferences.access`：

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

手改完之后**重启 bridge** 或者**找一个被允许的会话发 `/reconnect`** 让新配置生效。日常调整还是用 `/config` 表单更省事，直接改文件主要用在"部署脚本里预填"之类的场景。

## 常见问题

**Claude 挂住不回复**：通常是 `claude` CLI 本身没登录，或者 session 指向了不存在的 cwd。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**Claude 子进程假死（卡片停在最后一帧不动）**：从 0.1.20 起支持 idle 探活：claude 一段时间没输出就被 SIGTERM kill，卡片末尾会标 "⏱ N 分钟无响应，已自动终止"。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前 session 生效；`/timeout off` 关掉某个 session 的探活；`/timeout default` 清掉 session 覆盖回退到全局。

**飞书里显示 Claude 没有返回可见文本**：这通常说明 Claude 本轮只产出了 thinking / tool call / 空结果。bridge 会显示兜底提示并在结构化日志里写 `agent.empty-output`。可以直接重发，或者 `/reset` 开新 session 后重试。

**GUI 自动化没反应或截图黑屏**：先确认 Mac 没有 sleep / 锁屏，目标 app 在当前桌面可见，computer-use 相关权限已授权。长时间远程跑 GUI 任务时可以用 `caffeinate -dimsu` 保持系统和显示可用。

**图片发过去 Claude 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 开发 / 接手检查清单

关键文件：

- `src/commands/index.ts`：飞书 slash command handler，`/effort` / `/new low` / `/config` 都在这里
- `src/session/store.ts`：每个 chat/topic 的 session id、cwd、timeout override、effort override 持久化
- `src/bot/channel.ts`：批处理消息、计算最终 effort、调用 `agent.run()`
- `src/agent/claude/adapter.ts`：spawn `claude -p`，传 `--model` / `--effort` / `--mcp-config` / `--allowed-tools`
- `src/card/templates.ts`、`src/card/config-card.ts`：`/status`、`/help`、`/config` 卡片
- `test/effort.test.ts`：effort 规范化和 session override 持久化测试

上线前建议跑：

```bash
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsup
git diff --check
lark-channel-bridge restart
lark-channel-bridge status
```

有些环境没有全局 `pnpm`，直接用 `./node_modules/.bin/...` 更稳。重启后看 `~/.lark-channel/logs/$(date +%F).log`，确认最后有 `phase=ws event=connected`。

## 许可

[MIT](./LICENSE)
