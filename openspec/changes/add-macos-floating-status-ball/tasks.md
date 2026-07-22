## 1. 状态模型与配置

- [x] 1.1 新增桌面状态类型定义，覆盖 `offline`、`connecting`、`idle`、`queued`、`thinking`、`tool_running`、`streaming`、`reconnecting`、`error`
- [x] 1.2 实现 profile 状态快照 schema，字段仅包含 profile、botName、agent、状态、计数、更新时间与低敏错误类型
- [x] 1.3 实现聚合状态优先级计算，确保多 profile 时取最高关注度状态
- [x] 1.4 新增原子状态写入能力，支持多 profile 安全更新全局状态快照或 profile 独立状态文件
- [x] 1.5 新增悬浮球位置偏好读写能力，并处理保存位置超出当前屏幕的兜底策略
- [x] 1.6 扩展配置 schema，新增 `desktop.floatingBall.enabled` 或等价配置项，缺省时 macOS 默认为开启

## 2. CLI 与平台 gating

- [x] 2.1 在 `start` 命令新增 `--no-floating-ball` 参数，并传递到运行时启动选项
- [x] 2.2 在 service start 路径读取配置项与 `--no-floating-ball` 决定是否启用悬浮球
- [x] 2.3 实现 macOS-only gating，确保 Linux / Windows 不启动悬浮球
- [x] 2.4 实现 helper 启动失败降级逻辑，仅记录 warning，不阻断 bridge 启动
- [x] 2.5 为配置优先级添加单元测试：CLI 参数高于配置项，非 macOS 强制禁用

## 3. bridge 状态发布

- [x] 3.1 在进程注册后写入 `connecting` 状态，并在 WS 握手成功后更新为 `idle`
- [x] 3.2 在 WS `reconnecting` / `reconnected` 事件中更新 profile 状态
- [x] 3.3 在 pending queue 入队、阻塞、解除阻塞时更新 `queued` 或恢复当前状态
- [x] 3.4 在 `RunExecutor.submit` 成功后写入 active run 状态与 run 计数
- [x] 3.5 在 agent stream 状态变化时映射 `thinking`、`tool_running`、`streaming`
- [x] 3.6 在 run 终止、interrupt、idle timeout 或 error 后恢复 `idle` 或写入短暂错误状态
- [x] 3.7 在 bridge disconnect、process exit 和 profile 停止时清理或标记该 profile 为 offline
- [x] 3.8 添加状态快照隐私测试，断言不写入 message、prompt、tool payload、chatId、threadId、sessionId、secret 或 token

## 4. macOS 悬浮球 helper

- [x] 4.1 新增 macOS 原生 helper 工程或可执行目标，实现无边框置顶悬浮球窗口
- [x] 4.2 实现单实例保护，避免多个 profile 启动多个悬浮球
- [x] 4.3 实现状态快照监听与兜底轮询，驱动悬浮球颜色、动效或状态标签更新
- [x] 4.4 实现悬浮球拖动，并在拖动结束后持久化位置
- [x] 4.5 实现启动时恢复悬浮球位置，位置不可见时移动到主屏幕安全区域
- [x] 4.6 实现 hover 左右展开 profile 状态列表，展示所有可见 profile 的名称和状态
- [x] 4.7 实现鼠标移出悬浮球与展开区域后自动收起
- [x] 4.8 确保展开列表保持在当前屏幕可见区域内

## 5. 集成与发布

- [x] 5.1 在 macOS `start` 和 launchd service 启动路径中启动或唤醒 helper
- [x] 5.2 确认 helper 的打包方式，并纳入 macOS 发布产物或安装流程
- [x] 5.3 更新用户文档，说明默认开启、`--no-floating-ball`、配置项关闭、多 profile 聚合和隐私边界
- [x] 5.4 更新开发文档，说明状态快照字段、状态优先级与 helper 调试方式

## 6. 验证

- [x] 6.1 添加单元测试覆盖状态优先级、profile 聚合、快照写入与 profile 清理
- [x] 6.2 添加单元测试覆盖 CLI 参数、配置项和平台 gating
- [ ] 6.3 添加 macOS helper 可验证测试或最小 UI 自动化测试，覆盖读取快照、拖动位置和 hover 展开
- [x] 6.4 编写 `manual-verification.md`，覆盖单 profile、多 profile、hover 左右展开、拖动持久化、重连、错误、helper 启动失败和关闭配置
- [ ] 6.5 手动验证 macOS 桌面只出现一个悬浮球，并在多 profile 场景正确展开所有 profile
