# multi-window-bridge — 多窗口 Claude ↔ 飞书 通知桥

把多个 Warp 窗口里跑着的 Claude Code 会话「**主动喊飞书**」+「**飞书喊回来**」串成一张通知网。出门 / 在另一个房间 / 在另一个屏幕，照样知道哪个窗口需要你管它。

---

## 它解决什么问题

你现在：
- 同时开 4 个 Warp 窗口，每个跑一个 Claude Code，做不同任务
- 离开电脑去开会
- 回来发现：1 号窗口在 20 分钟前就在等你回复某个问题，3 号窗口在 5 分钟前完成了一个大任务，4 号窗口卡在某个错误上

你想要的：
- 1 号窗口等输入 → 手机收到飞书消息「**[kb-debug] 需要你回复**」
- 3 号完成 → 「**[yitang-fix] 已完成**」
- 4 号卡 10 分钟没动 → 「**[code-review] 疑似卡死**」
- 看到消息后，**直接在飞书里回复**，本机会自动开新 Warp tab 把回复接上原会话继续干

这套就是干这个的。

---

## 跟现有 `lark-channel-bridge` 是啥关系

**完全不冲突，两套独立跑。**

| | lark-channel-bridge（已经在跑的） | multi-window-bridge（本套） |
|---|---|---|
| 触发方向 | 飞书发消息 → 本机新开一个 Claude 跑完即退 | 本机已开的 Claude → 飞书；飞书回复 → 接回本机已开的 Claude |
| 生命周期 | 短命子进程，每条消息独立 | 跟随你手开的 Warp 窗口，跨多轮对话 |
| 飞书 bot | 同一个 bot（你的飞书 bot） | 同一个 bot |
| 区分方式 | 任意飞书消息都触发 | **只处理带 `[window-id]` 标记的回复**，其余留给 lark-channel-bridge |

凭据共享：本套读 `~/.lark-channel/config.json`，不另存一份。

---

## 怎么装

本项目假定装在 `~/.claude/multi-window-bridge/`。从本仓库安装：先把 `contrib/multi-window-bridge/` 整个目录复制过去，再跑 installer：

```bash
cp -R contrib/multi-window-bridge ~/.claude/multi-window-bridge
~/.claude/multi-window-bridge/bin/mwb-install
source ~/.zshrc          # 让 cc-register 在当前终端生效
~/.claude/multi-window-bridge/bin/mwb-test   # 应该收到一条飞书测试消息
```

> 装之前先把 `config/config.json` 里的 `feishu.chatId` / `feishu.userOpenId` 填成你自己的（占位符是 `oc_xxx…` / `ou_xxx…`），`credentialFile` 默认复用 lark-channel-bridge 的 `~/.lark-channel/config.json`。

装完之后做了什么：
1. 在 `~/.claude/settings.json` 的 `hooks` 段加了 5 条 MWB hook（**不影响你已有的 UserPromptSubmit + statusLine**，原文件备份在 `settings.json.bak.<时间戳>`）
2. 在 `~/.zshrc` 加了一行 `source ~/.claude/multi-window-bridge/bin/cc-register`，引入 `cc-register` 命令
3. 起了一个 launchd 守护进程 `com.local.mwb-watchdog`（每 60 秒巡逻一次，发"疑似卡死"通知）

---

## 怎么用（日常）

### 开一个会话

老办法：直接 `claude` —— **依然有效**，会自动起一个 `<目录名>-<序号>` 的 window-id（比如 `kb-1`）。

新办法（推荐，想给会话起个有意义的名字）：

```bash
cc-register --alias=fix-onboarding-bug
# 或者
cc-register -a perf-review
```

然后正常用 Claude 就行，不需要做别的。

### 打开多个窗口

Warp 里 Cmd+T 开新 tab → `cd 到对应目录` → `cc-register --alias=xxx`。每个 tab 一个 alias，互不打扰。

### 查看当前有哪些会话在跑

```bash
cat ~/.claude/multi-window-bridge/registry.json | python3 -m json.tool
```

或者看实时日志：

```bash
tail -f ~/.claude/multi-window-bridge/logs/$(date +%F).log
```

---

## 飞书会收到哪些消息

| 触发点 | 消息长什么样 | 频率 |
|---|---|---|
| Claude 等你输入 | 🟡 [kb-1] 需要你回复 / 💬 \<最后一段提示\> | 每次 Claude 弹问题（带 5 秒 per-window 节流） |
| 即将跑敏感工具 | 🔧 [kb-1] 即将执行 Bash / $ rm -rf foo | 仅 Bash / Edit / Write / NotebookEdit |
| 任务完成 | ✅ [kb-1] 已完成 / \<最后一段输出\> | 每个 Stop（可在 config 关掉） |
| 疑似卡死 | ⚠️ [kb-1] 疑似卡死 / ⏱ 最后活动 12 分钟前 | watchdog 巡逻，阈值默认 10 分钟，30 分钟内不重复 |

不想被某类消息打扰？编辑 `~/.claude/multi-window-bridge/config/config.json` 的 `notifications` 段把对应开关设 `false`，下一秒生效。

---

## Stage 2：飞书回复 → 接回本机（默认关，需要手动打开）

### 怎么开

```bash
# 1. 把 config.json 里 stage2.enabled 改成 true
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/multi-window-bridge/config/config.json')
c = json.load(open(p))
c['stage2']['enabled'] = True
json.dump(c, open(p,'w'), indent=2, ensure_ascii=False)
print('stage2 enabled')
"

# 2. 起 receiver
launchctl load ~/Library/LaunchAgents/com.local.mwb-receiver.plist
```

### 在飞书里怎么回复

**3 种回复方式都认**：

1. **方括号前缀**（推荐）：`[kb-1] 帮我把那个 bug 修了` ✅
2. **冒号前缀**：`kb-1: 帮我把那个 bug 修了` ✅
3. **引用回复**：直接对 bot 发的某条通知点引用回复，正文写你要说的，不带任何前缀 ✅

⚠️ **不带 window-id 前缀也不引用回复的纯文本消息，本套不处理**，留给 `lark-channel-bridge` 兜底（它会按它原本的逻辑去 spawn 一个新 claude）。

### 飞书回复后，本机发生什么

**回答："会开一个新的 Warp tab，原来那个窗口会自己关掉。"**

技术上发生这几步：
1. receiver 30 秒一次拉飞书消息，发现一条 `[kb-1] xxx`
2. 看 registry，找到 `kb-1` 对应的 sessionId 和 PID
3. **把原 PID 杀掉**（不然两个 claude 同时写一个 session 文件会乱）
4. 开一个新 Warp tab，跑 `claude --resume <sessionId>`
5. 你的回复内容自动复制到剪贴板
6. 等 Claude TUI 起来后，**你在 Warp 里按 Cmd+V 然后回车**就行

### 为什么不直接在原 Warp tab 里"自动打字"？

我们试过了，**太脆弱**。Warp 没给一个稳定的方式让外部程序往它的 TUI 里塞键盘输入。会出这些问题：
- 你切到了别的 app，键盘事件跑到那边去
- 你切到了别的 tab，回复打到了错的 Claude 上
- Claude 在弹某个内部弹窗（/help、模型选择等），输入被弹窗吞掉

所以**默认走"新开 tab + 你自己粘"**这条路。慢一秒，但 100% 可靠。原窗口里的 claude 会自己结束，剩个空 shell prompt 你随手 Cmd+W 关掉就行。

### 我懒，能让它全自动粘吗？

可以，但要先**给 osascript 系统辅助功能权限**：

1. 系统设置 → 隐私与安全 → 辅助功能 → 加 `/usr/bin/osascript`（或勾上你的终端 app）
2. `config.json` 把 `stage2.allowAppleScriptPaste` 改成 `true`
3. 测一次：飞书发 `[kb-1] hello`，看新 tab 里自不自动粘进去 + 回车

⚠️ **不保证 100% 可靠**——Warp 升级、系统升级都可能让 AppleScript 焦点抢错。出问题就关回 `false`。

---

## 关掉 / 卸载

```bash
~/.claude/multi-window-bridge/bin/mwb-uninstall          # 软卸（保留 logs/registry）
~/.claude/multi-window-bridge/bin/mwb-uninstall --purge  # 彻底删
```

`mwb-uninstall` 只删本套的东西：
- 移除 settings.json 里以 `/multi-window-bridge/hooks/` 开头的 hook（**其它 hook 不动**）
- 从 ~/.zshrc 删掉 cc-register 那行
- unload + 删 launchd plist

`lark-channel-bridge` 完全不受影响。

---

## 常见问题

**Q：装完没收到测试消息**
A：`~/.claude/multi-window-bridge/bin/mwb-test` 跑一次。如果失败，看 `~/.claude/multi-window-bridge/logs/$(date +%F).log` 里 `feishu.send.fail` 那一行。最常见原因是网络代理（参考 你的代理配置 ClashX 配置）。

**Q：cc-register 命令找不到**
A：`source ~/.zshrc` 一次。或者重新开个 Warp tab。

**Q：window-id 想改名**
A：直接 `cc-register --alias=新名字` 重新开一个会话就行。旧 alias 在 SessionEnd 后自动注销。

**Q：飞书消息太吵了**
A：编辑 `config.json` 的 `notifications` 段：把 `onStop` 关掉是最大改善（任务完成不再喊你）。`onToolAuth` 关掉就只剩 `需要回复` 和 `疑似卡死`。

**Q：watchdog 误报"疑似卡死"（任务确实在跑，只是很长）**
A：把 `watchdog.staleThresholdSeconds` 从 600 调大到 1800。

**Q：装完之后 Claude 启动变慢了**
A：每个 hook 跑一次 Python import，第一次约 80ms。如果体感卡，看 logs/ 里有没有 `hook.*.fail`。所有 hook 的 timeout 在 settings.json 里限了 5-8 秒，超时不会卡住 Claude 主流程。

**Q：能跟 lark-channel-bridge 同时收发同一个 chat 吗？**
A：能。lark-channel-bridge 走飞书 webhook 事件订阅，本套走 REST API 拉取。两条路径互不抢。但**飞书 chat 里同一条消息，两边都会看见**——本套用 `[window-id]` 前缀过滤，没匹配上的留给 lark-channel-bridge。

---

详细架构图见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，失败模式排查见 [`FAILURE-MODES.md`](FAILURE-MODES.md)。
