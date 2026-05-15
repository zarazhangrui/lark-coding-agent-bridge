# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code CLI 打通的轻量 bot，用一条命令起服务，扫码绑应用，在飞书里和 Claude 对话、让它读图 / 改代码。

[English README](./README.md)

## 能干什么

- 在飞书（私聊直接发；群里 `@bot`）把消息转给本地的 `claude` CLI，Claude 在你指定的工作目录里工作
- **流式卡片**：Claude 的文本和工具调用实时出现在同一张卡片上，不用傻等
- **会话延续**：每个 chat 独立 session，对话能接着上次说
- **抢占 + 批处理**：中途发新消息会打断旧任务；快速连发几条会合并成一次请求
- **多工作空间**：`/ws` 切换不同项目，session 自己重置
- **图片 / 文件**：直接发给 bot，Claude 会读本地下载的文件路径
- **卡片按钮**：`/help` `/ws list` `/status` 返回交互卡片，点按钮直接操作

## 前置条件

- Node.js **≥ 20**
- 任选其一的 coding-agent CLI，已安装并登录：
  - `claude`（Claude Code）：https://docs.anthropic.com/en/docs/claude-code/quickstart  *（默认）*
  - `codex`（OpenAI Codex CLI）：`codex login` 完成认证
- 一个飞书 / Lark PersonalAgent 应用（首次启动的扫码向导能帮你创建）

## 安装

```bash
npm i -g lark-channel-bridge
# 或
pnpm add -g lark-channel-bridge
```

## 首次启动

```bash
lark-channel-bridge start
```

第一次跑会检测到没配置应用，**自动进入扫码向导**：

1. 终端渲染一个二维码
2. 用飞书 App 扫码
3. 选择 / 创建 PersonalAgent 应用
4. 成功后凭据写入 `~/.lark-channel/config.json`

### 开放平台补齐 scope 和事件订阅

向导只负责创建应用，平台侧还需要手动确认：

**权限 scope**：
- `im:message`
- `im:message:send_as_bot`
- `im:resource`

**事件订阅（使用长连接接收）**：
- `im.message.receive_v1`
- `card.action.trigger`
- `im.message.reaction.created_v1` / `deleted_v1`（可选）
- `im.chat.member.bot.added_v1`（可选）

启用以后再次 `lark-channel-bridge start`，看到 `✓ 已连接` 就可以在飞书里找 bot 对话了。

### 同时跑 Claude 和 Codex 两个 bot

每个 agent 用独立的数据目录和独立的飞书 app 同机并行：

```bash
# 原 Claude bot — ~/.lark-channel/，agent=claude
lark-channel-bridge start            # 或：start --claude

# 新加一个 Codex bot — ~/.lark-codex/，agent=codex
lark-channel-bridge start --codex
```

`--codex` 自动指向 `~/.lark-codex/config.json`，首次跑触发扫码向导让你绑定**第二个** PersonalAgent 应用，并把 `preferences.agent = "codex"` 写进那份 config。两个进程共用 `processes.json` 注册机制，`lark-channel-bridge ps` 都能看到。两个数据目录里的 sessions / workspaces / logs / media 互不干扰。

需要更自定义的位置时 `-c <path>` 依然可用：数据目录就是 `dirname(path)`。`-c` 和 `--codex` 可以叠加——`-c` 决定路径，`--codex` 负责写 agent 偏好。

> Codex 0.128 的 `exec --json` 不输出文本 delta，所以卡片内容是整段一次性出现，不是打字机式增量；不过工具调用（`command_execution` / `file_change`）依然有 started/completed 双事件，panel 会实时更新。

## 命令速查

### 宿主 CLI

```
lark-channel-bridge start [-c <config>] [--claude|--codex]   启动 bot
lark-channel-bridge ps                                       列出本机所有正在跑的 start 进程
lark-channel-bridge stop <id|#>                              终止指定 start 进程（SIGTERM，2s 后 SIGKILL）
lark-channel-bridge --help                                   列所有命令
```

> 多开同一个 app 时，开放平台会把事件随机推到其中一个长连接。`start` 启动前会检测同 app 已有的进程，TTY 下提示 `[c]ontinue / [k]ill old / [a]bort` 三选；非 TTY 只 warn 并继续。

其它命令（`status` / `doctor` / `handover` / `workspace` / `service`）是占位，后续版本补。

### 在飞书里用的斜杠命令

| 命令 | 作用 |
|---|---|
| `/new` `/reset` | 清空当前 chat 的会话 |
| `/cd <path>` | 切换工作目录（会重置 session） |
| `/ws list` | 列所有命名工作空间（卡片 + 按钮） |
| `/ws save <name>` | 把当前 cwd 存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/status` | 当前 cwd / session / agent（卡片 + 按钮） |
| `/config` | 调整偏好（消息回复方式、工具调用显示等） |
| `/stop` | 终止当前正在跑的 run（也可点卡片底部 ⏹ 终止 按钮） |
| `/timeout [N\|off\|default]` | 当前 session 的 idle 探活（分钟）；`/config` 改全局默认。详见下方"常见问题 — Claude 子进程假死" |
| `/ps` | 列出本机所有 start 进程，标识当前回复的是哪个 |
| `/exit <id\|#>` | 终止指定 start 进程（自己 = graceful 退出；他人 = SIGTERM） |
| `/reconnect` | 强制重连 WebSocket（网络抖动后 bot 没反应时用） |
| `/doctor [描述]` | 把最近运行日志和你的描述喂给 Claude，自助诊断卡住 / 异常的原因 |
| `/help` | 帮助卡片 |
| 其它 `/xxx` | 原样交给 Claude |

**消息策略**：私聊 = 不需要 @，任何消息都回；**群（含话题群）= 默认要 @bot 才回**（0.1.22 起的新默认），不 @ 时 bot 完全沉默；@全员永远不响应；云文档评论必须 @bot。要恢复"群里也不强制 @"的老行为：`/config` → "群里需要 @ bot" → 选"否"。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 应用凭据（App ID / Secret），权限 600 |
| `~/.lark-channel/sessions.json` | 每个 chat / 话题 的 Claude session id + cwd（+ 可选的 `/timeout` 覆盖） |
| `~/.lark-channel/workspaces.json` | 工作空间映射 |
| `~/.lark-channel/processes.json` | 当前在跑的 start 进程注册中心（`ps`/`stop` 用），死进程会被自动清理 |
| `~/.lark-channel/media/<chatId>/` | 下载的图片 / 文件，24h 自动清理 |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | 结构化运行日志（JSON line），按天滚动；启动时清理超过 7 天的老文件（`LARK_CHANNEL_LOG_DAYS` 环境变量可改）；`/doctor` 命令读它做诊断 |

> 升级自 0.1.11 之前的版本？跑一次 `lark-channel-bridge migrate` —— 自动把 `~/.config/lark-channel-bridge/` 和 `~/.cache/lark-channel-bridge/` 下的内容搬到新位置，并把 `config.json` 升级到新结构。

## 常见问题

**Claude 挂住不回复**：通常是 `claude` CLI 本身没登录，或者 session 指向了不存在的 cwd。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**Claude 子进程假死（卡片停在最后一帧不动）**：从 0.1.20 起支持 idle 探活：claude 一段时间没输出就被 SIGTERM kill，卡片末尾会标 "⏱ N 分钟无响应，已自动终止"。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前 session 生效；`/timeout off` 关掉某个 session 的探活；`/timeout default` 清掉 session 覆盖回退到全局。

**图片发过去 Claude 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 许可

[MIT](./LICENSE)