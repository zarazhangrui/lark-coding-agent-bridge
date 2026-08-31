# Failure modes & self-healing

每一行 = 一个模块挂掉时，你会观察到什么、怎么自愈。

## 1. 模块 × 现象 × 排查

| 模块 | 挂掉时你会看到 | 自动自愈 | 手动恢复 |
|---|---|---|---|
| **registry.json** 文件损坏 (异常断电 / 磁盘满) | hooks 跑出来日志 `registry.corrupt`；飞书还在发但 window-id 全 reset 为 `<basename>-1` | hooks 检测到非法 JSON 时把 registry 当空的重建 | 没事可做。如果你想要原始数据，看 `~/.claude/multi-window-bridge/logs/<日期>.log`，每个 SessionStart 都记了 sessionId |
| **lark-channel/config.json 没了 / 改密** | 所有 hook 日志里 `feishu.token.fail`；飞书不发任何东西 | 不会自愈 | 重跑 `lark-channel-bridge start` 走扫码流程；或手动改 `~/.lark-channel/config.json`。MWB 会自动重读 |
| **token 缓存过期** (cached token 失效但磁盘上还在) | 偶尔某条消息发不出去，下次就好了 | 是 — `feishu.py` 失败后下次调用会重新走 `/auth/v3/tenant_access_token/internal` | 手动: `rm ~/.claude/multi-window-bridge/.tenant_token.json` |
| **watchdog 进程崩了** | 不再收到"疑似卡死"通知；hook 通知正常 | 是 — launchd `KeepAlive.Crashed=true` 10 秒内重启；`ThrottleInterval=10` 防疯狂重启循环 | `launchctl list \| grep mwb-watchdog` 看 PID + exit code；看 `logs/watchdog.err.log` |
| **watchdog 死循环不退出** | watchdog 进程占 CPU；通知卡 | 不会自愈 | `launchctl unload ~/Library/LaunchAgents/com.local.mwb-watchdog.plist && launchctl load ...` |
| **某个 Claude 进程 SIGKILL 突然死** (没触发 SessionEnd) | registry 里残留该 window；watchdog 下次巡逻发现 PID 已死，evict + 不通知 | 是 — `watchdog._tick` 先做 `_prune_dead`，evict 不发飞书（用户已经关窗口了，没必要再喊） | 没事可做 |
| **hook 超时** (>= 5-8s 没返回) | Claude 主流程不卡 (Claude 强制超时)；某条通知没发出去 | hook 是 fire-and-forget，下次事件还会发 | 看 `logs/<日期>.log` 里 `hook.*.fail`；常见是 feishu 那边网络慢 |
| **receiver 拉到 0 条消息** (Stage 2) | 飞书回复"[kb-1] xxx" 30s 内本机没反应；超过 1 分钟还没反应说明真挂了 | 是 — launchd 重启 receiver | 看 `logs/receiver.err.log`；最常见: token 过期 / 网络问题 |
| **receiver 把消息派给错的 window** | 新 Warp tab 跑了 `claude --resume <错的 sid>`，回复落到错的会话上 | 不会自愈 | 这种"误派"意味着 alias 撞了 — 自查 registry.json 里有没有重名 window-id；用 `cc-register --alias=明确点的名字` 避免 |
| **AppleScript 自动粘贴失败** (Stage 2 + allowAppleScriptPaste=true) | 新 Warp tab 起来了，TUI 在那，但回复文本没出现 | 不会自愈；剪贴板里还在 | 用户直接在 Warp 里 Cmd+V + Enter 即可；考虑把 `allowAppleScriptPaste` 关回 false |
| **Warp 没装 / 改名** | router 报 `osascript phase1 rc=...`；飞书回复说"resume failed" | 不会自愈 | 修 `config.json.stage2.warpAppPath`，或先关 Stage 2 临时回退 |
| **ClashX fake-ip 干掉 feishu API** (参考 你的代理配置) | 全部 feishu 调用 `network: ECONNRESET` 或 super slow | 不会自愈 | 检查 ClashX yaml 的 `fake-ip-filter`，确保 `*.feishu.cn` 在过滤名单里 |

## 2. 通用排查动作（按顺序试）

```bash
# 1. 看今天的日志（hooks + watchdog + receiver 都写在这）
tail -50 ~/.claude/multi-window-bridge/logs/$(date +%F).log

# 2. 看 launchd 服务状态
launchctl list | grep mwb

# 3. 看 launchd stderr (启动失败 / 路径错的话会在这)
cat ~/.claude/multi-window-bridge/logs/watchdog.err.log
cat ~/.claude/multi-window-bridge/logs/receiver.err.log  # Stage 2 才有

# 4. 看 registry 状态
cat ~/.claude/multi-window-bridge/registry.json | python3 -m json.tool

# 5. 看飞书 token 缓存
ls -la ~/.claude/multi-window-bridge/.tenant_token.json

# 6. 重启 watchdog (大多数"为什么不发了"问题的速效药)
launchctl unload ~/Library/LaunchAgents/com.local.mwb-watchdog.plist
launchctl load ~/Library/LaunchAgents/com.local.mwb-watchdog.plist

# 7. 重启 receiver (Stage 2)
launchctl unload ~/Library/LaunchAgents/com.local.mwb-receiver.plist
launchctl load ~/Library/LaunchAgents/com.local.mwb-receiver.plist

# 8. 端到端 smoke (跳过 hooks 直接试 feishu send)
~/.claude/multi-window-bridge/bin/mwb-test
```

## 3. 哪些 corner case **不**自动处理（已知，故意的）

- **同 alias 撞名**：`cc-register --alias=foo` 开两次 → 第二次会变成 `foo-2`。**不会**报错或弹警告。背后原因：宁可静默续号，也别打断用户工作流。
- **PID 复用**：极少数情况下，一个 Claude 进程退出后，几小时内系统把同一个 PID 分配给别的进程。watchdog 巡逻时会把这个"非 Claude 的进程"当成"我们的 Claude"。后果：永远不会触发 evict（除非那个进程也死），偶尔误发"疑似卡死"。**接受**这个边界 case，30 分钟 rearm 让噪音可控。
- **AppleScript 焦点抢错** (Stage 2 + auto-paste)：上面表里列了，重申一次——这就是为啥默认关。**别在 `allowAppleScriptPaste=true` 时同时手敲键盘**。
- **Claude session.jsonl 锁冲突**：理论上 `--resume` 时如果旧 PID 没杀干净，新旧两个 claude 进程会同时写一个文件。router 主动 `SIGTERM` + sleep 0.5s 后才 resume，**绝大多数情况够用**。极少数老 PID 在 GC 大对象时 SIGTERM 没立即响应，看到 session 写入冲突的话，等 5s 重试。
- **飞书 API 限流**：飞书私聊单 bot 大概每秒 5 条够用。**watchdog 同一窗口 30 分钟才再 alert 一次**就是为了不撞限流。极端情况（10 个窗口同时卡死）也只会触发 10 条通知，远低于限流。

## 4. 卸载后还需要清理的（mwb-uninstall 不会动的东西）

- `~/.lark-channel/` —— lark-channel-bridge 的东西，不该动
- 已发出去的飞书消息 —— 历史记录，飞书侧
- `~/.claude/settings.json.bak.<时间戳>` —— 故意留着，万一你要回滚
- (Stage 2) Accessibility 权限 —— 如果你给过 osascript，系统设置里还在，可以手动撤
