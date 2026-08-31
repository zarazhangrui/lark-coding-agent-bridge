# Multi-Window Bridge — 架构

## 1. 总览

```
 ┌────────────────────────── 一个 Warp 窗口 = 一个 Claude Code 会话 ──────────────────────────┐
 │                                                                                              │
 │   $ cc-register --alias=kb-debug   (zsh function, 可选别名)                                  │
 │           │                                                                                  │
 │           ▼  设置 MWB_WINDOW_ALIAS env → exec claude                                          │
 │   ┌──────────────────────────────┐                                                           │
 │   │   claude (Code TUI)          │  ◀────── 用户在这里干活                                    │
 │   │                              │                                                           │
 │   │  triggers:                   │                                                           │
 │   │   • SessionStart  ──►  registry.py  注册 {window-id, pid, cwd, session_id}              │
 │   │   • Notification  ──►  feishu.py    "[kb-debug] 需要回复…"                              │
 │   │   • PreToolUse    ──►  feishu.py    "[kb-debug] 申请执行 Bash: rm -rf …"                │
 │   │   • Stop          ──►  feishu.py    "[kb-debug] 已完成"  (可关)                          │
 │   │   • SessionEnd    ──►  registry.py  注销                                                 │
 │   └──────────────────────────────┘                                                           │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │ JSON 文件 + flock
                                              ▼
                                   ┌────────────────────────┐
                                   │  registry.json         │  ◀── 全局唯一事实
                                   │  ~/.claude/MWB/        │      window-id ↔ {pid, sid, cwd, lastHookAt, lastHookKind}
                                   └────────────────────────┘
                                              │
                                              │ 读取 (60s 一次)
                                              ▼
                                   ┌────────────────────────┐
                                   │  watchdog.py (launchd) │  超过阈值无 hook 心跳 + 进程仍活 → 发"疑似卡死"
                                   └────────────────────────┘
                                              │
                                              ▼
                                       feishu.py (sender)
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────────┐
                       │  飞书 bot (cli_xxxxxxxxxxxxxxxx / "你的飞书 bot") │
                       │  凭据复用 ~/.lark-channel/config.json              │
                       │  目标 chat = oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  │
                       └──────────────────────────────────────────────────┘
                                              │
                                              ▼ 用户回复  "[kb-debug] 继续干"
                                              │
                                   ┌────────────────────────┐
                                   │  receiver.py (Stage 2) │  每 30s 拉新消息
                                   │  (launchd)             │  解析 [window-id] 前缀 OR 引用回复
                                   └────────────────────────┘
                                              │
                                              ▼
                                   ┌────────────────────────┐
                                   │  router.py (resume)    │  ① kill old pid (若仍活)
                                   │                        │  ② AppleScript 开新 Warp tab
                                   │                        │  ③ 跑  claude --resume <sid>
                                   │                        │  ④ 用 pbcopy + Cmd+V 把回复粘进去 + Enter
                                   └────────────────────────┘
```

## 2. 五个模块

| 模块 | 文件 | 触发方式 | 核心职责 |
|---|---|---|---|
| **registry** | `lib/registry.py` | 函数库 (被 hook 调用) | `~/.claude/multi-window-bridge/registry.json` 的原子读写，flock 防并发 |
| **hooks** | `hooks/*.py` | Claude Code 在事件点 spawn | 写心跳到 registry + 调 feishu.py 发通知 |
| **watchdog** | `daemon/watchdog.py` | launchd KeepAlive | 每 60s 扫 registry，发"疑似卡死"，回收死进程残留 |
| **feishu sender** | `lib/feishu.py` | 被 hooks + watchdog 调用 | 读 lark-channel-bridge 的 config.json → tenant_access_token → `POST /im/v1/messages` |
| **receiver + router** | `daemon/receiver.py` + `daemon/router.py` | launchd (Stage 2) | 轮询飞书 chat 新消息，解析 window-id，开新 Warp tab `claude --resume` 并粘入回复 |

## 3. 与现有 `lark-channel-bridge` 的边界

| 维度 | lark-channel-bridge | multi-window-bridge (本项目) |
|---|---|---|
| **触发方向** | 飞书 → spawn 新 claude (无状态) | claude → 飞书 (主动), 飞书 → 已有 claude session (Stage 2) |
| **进程生命周期** | 收到飞书消息时短 spawn / 跑完即退 | 跟随用户在 Warp 里手开的 claude 进程 |
| **会话识别** | 按飞书 chat_id 维护 sessionId 映射 | 按 window-id (`{cwd-basename}-{N}`) 映射 sessionId + claude PID |
| **凭据来源** | `~/.lark-channel/config.json` (自有) | 读同一份 config.json (不复制) |
| **bot App ID** | cli_xxxxxxxxxxxxxxxx | 同上 (复用) |
| **launchd 服务** | `com.local.lark-channel-bridge.plist` | `com.local.mwb-watchdog.plist` + `com.local.mwb-receiver.plist` |
| **冲突点** | 飞书事件订阅 URL: 同一 App 只能一个 webhook | **本项目不订 webhook，只拉 REST API**，所以不抢 |
| **消息互看** | 都进同一个 chat | receiver 用 `last_seen_msg_id` 过滤，只处理 `[window-id]` 前缀消息，剩下的留给 lark-channel-bridge |

**关键设计**：本项目**不订阅飞书 event webhook**，避免和 lark-channel-bridge 抢消息路由。Stage 2 用 `im/v1/messages` REST 拉取，间隔 30s。代价：回复延迟 15-30s（用户能接受，飞书发完就放下手机）。

## 4. 数据结构

### registry.json

```json
{
  "version": 1,
  "windows": {
    "kb-1": {
      "alias": "kb-1",
      "cwd": "/Users/you/kb",
      "claudePid": 12345,
      "sessionId": "7b2838bc-...",
      "transcriptPath": "/Users/you/.claude/projects/-Users-you-kb/7b2838bc-....jsonl",
      "startedAt": 1779030000,
      "lastHookAt": 1779031200,
      "lastHookKind": "Notification",
      "lastHookSummary": "Claude is waiting for your input",
      "registeredManually": true
    },
    "kb-2": { "...": "..." }
  },
  "notifications": {
    "om_xxx_msg_id": { "windowId": "kb-1", "kind": "Notification", "sentAt": 1779031200 }
  }
}
```

- `windows` — 活会话
- `notifications` — 出账消息 ID 反查表（最多保留 200 条，给 Stage 2 的"引用回复"路由用）

### config/config.json

```json
{
  "feishu": {
    "chatId": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "credentialFile": "~/.lark-channel/config.json"
  },
  "notifications": {
    "onInput": true,
    "onToolAuth": true,
    "onStop": true,
    "onWatchdog": true,
    "toolAuthBashOnly": false,
    "toolAuthIncludes": ["Bash", "Edit", "Write", "NotebookEdit"]
  },
  "watchdog": {
    "intervalSeconds": 60,
    "staleThresholdSeconds": 600,
    "rearmAfterAlertSeconds": 1800
  },
  "stage2": {
    "enabled": false,
    "pollIntervalSeconds": 30,
    "allowAppleScriptPaste": false,
    "warpAppPath": "/Applications/Warp.app"
  }
}
```

设计原则：**默认保守** — Stage 2 关闭、AppleScript 自动粘贴关闭、watchdog 阈值 10 分钟。

## 5. Stage 2 决策（回复路由）

**方案 A 胜出**（spawn 新 Warp tab + `claude --resume <sid>`），不走方案 B (注入到原窗口)。

**为什么否决 B**：Warp 没有公开 Accessibility API 给 Claude Code 的 TUI 输入框，AppleScript 只能做"焦点到 Warp + keystroke"。这要求：
1. Warp 当前可见且没被遮 (失败：用户切到了别的 app)
2. 目标 tab 当前 active (失败：用户切到了别的 tab)
3. Claude TUI 输入框聚焦 (失败：用户在用 `/` slash command 弹窗)
4. 系统辅助功能权限给到 Terminal/launchd

任何一项不对 → 字符跑去别处了。这不是"v1 凑合用"级别的脆弱，是"用户会失去信任"级别的脆弱。

**方案 A 的"分身窗口"问题如何解决**：
- receiver 收到回复后，先 `kill -TERM <oldPid>` 把原窗口里的 claude 结束（registry 里有 PID）
- 然后开新 Warp tab 跑 `claude --resume <sid>`
- Claude 的 session.jsonl 是事实来源，新 tab 直接接上原会话完整上下文
- 用户体验：原窗口里 claude 进程退出后剩个空 shell prompt（用户可手动关或留着），新窗口里 claude 已经接住飞书的回复继续干

**为什么不用 `claude -p "<msg>" --resume <sid>`**（一次性 print 模式）：
- Print 模式跑完即退，用户回到电脑想跟进时还得再 `claude --resume <sid>`
- 把回复变成"一锤子买卖"，违背"双向交互"的目标

**AppleScript 自动粘贴默认关**（`stage2.allowAppleScriptPaste: false`）：
- 默认行为：开新 Warp tab + 跑 `claude --resume <sid>`，**用户的回复文本被 pbcopy 复制到剪贴板**，Claude TUI 起来后用户 Cmd+V 粘进去回车
- 进阶（用户自己打开开关 + 授辅助功能权限）：AppleScript 自动 Cmd+V + Enter，全自动
- 这个降级是有意的：让"基础能跑"和"全自动"分两步交付信任

## 6. 启动 / 关闭顺序

```
启动:
  1. mwb-install   写入所有文件 / 装 launchd plist / 在 ~/.zshrc 加 cc-register source
  2. source ~/.zshrc 或重开终端
  3. cc-register --alias=foo   开第一个会话 (alias 可选)
  4. (Stage 2 可选)  在 config.json 把 stage2.enabled 设 true → launchctl load receiver plist

关闭:
  1. mwb-uninstall  卸 launchd / 删 ~/.claude/multi-window-bridge/ / 移除 cc-register source / 还原 settings.json hooks
  2. (lark-channel-bridge 不受影响)
```

## 7. 文件清单

```
~/.claude/multi-window-bridge/
├── ARCHITECTURE.md              # 本文档
├── README.md                    # PM 友好的中文说明
├── FAILURE-MODES.md             # 模块挂掉时观察 + 自愈
├── config/
│   └── config.json              # 默认配置
├── lib/
│   ├── common.py                # 配置加载 / 日志 / flock
│   ├── registry.py              # registry 读写
│   └── feishu.py                # 飞书 API 客户端
├── hooks/
│   ├── session_start.py
│   ├── notification.py
│   ├── pre_tool_use.py
│   ├── stop.py
│   └── session_end.py
├── daemon/
│   ├── watchdog.py
│   ├── receiver.py              # Stage 2
│   └── router.py                # Stage 2
├── bin/
│   ├── cc-register              # zsh function (source)
│   ├── mwb-install
│   ├── mwb-uninstall
│   └── mwb-test                 # 冒烟测试
├── launchd/
│   ├── com.local.mwb-watchdog.plist
│   └── com.local.mwb-receiver.plist  # Stage 2
├── settings.patch.json          # 给 ~/.claude/settings.json 的 hooks 段补丁参考
├── registry.json                # 运行时 (不进 git)
└── logs/
    └── YYYY-MM-DD.log
```
