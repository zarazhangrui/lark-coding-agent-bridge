## ADDED Requirements

### Requirement: macOS 桌面悬浮球默认启用

系统 SHALL 在 macOS 上默认启用桌面悬浮球，用于展示当前 bridge / bot 的运行状态。

#### Scenario: macOS 默认启动悬浮球

- **WHEN** 用户在 macOS 上启动 bridge
- **AND** 未传入 `--no-floating-ball`
- **AND** 配置项未显式关闭悬浮球
- **THEN** 系统 SHALL 启动或唤醒桌面悬浮球
- **AND** bridge SHALL 继续正常启动和连接 bot

#### Scenario: 非 macOS 不启用悬浮球

- **WHEN** 用户在 Linux 或 Windows 上启动 bridge
- **THEN** 系统 SHALL NOT 启动桌面悬浮球
- **AND** 系统 SHALL NOT 因悬浮球不可用而影响后台服务启动

#### Scenario: 使用 CLI 参数关闭悬浮球

- **WHEN** 用户启动 bridge 时传入 `--no-floating-ball`
- **THEN** 系统 SHALL NOT 启动或唤醒桌面悬浮球
- **AND** bridge SHALL 继续正常启动和连接 bot

#### Scenario: 使用配置项关闭悬浮球

- **WHEN** 用户配置悬浮球为关闭
- **AND** 用户启动 bridge
- **THEN** 系统 SHALL NOT 启动或唤醒桌面悬浮球
- **AND** bridge SHALL 继续正常启动和连接 bot

### Requirement: 悬浮球展示聚合运行状态

桌面悬浮球 SHALL 展示所有本机可见 profile 的聚合状态，聚合状态 SHALL 由各 profile 状态中最高优先级状态决定。

#### Scenario: 单 profile 空闲

- **WHEN** 只有一个 profile 正在运行
- **AND** bot 已连接
- **AND** 没有排队消息或 active run
- **THEN** 悬浮球 SHALL 展示空闲状态

#### Scenario: 单 profile 正在处理任务

- **WHEN** 任一 profile 的 agent run 进入 thinking、tool_running 或 streaming 状态
- **THEN** 悬浮球 SHALL 展示对应的忙碌状态
- **AND** 展示状态 SHALL 来源于 bridge 进程内的 run / stream 状态

#### Scenario: 任一 profile 正在重连

- **WHEN** 任一 profile 的 WS 连接进入 reconnecting 状态
- **THEN** 悬浮球 SHALL 展示重连状态

#### Scenario: 任一 profile 出错

- **WHEN** 任一 profile 最近一次连接或 run 进入 error 状态
- **THEN** 悬浮球 SHALL 展示错误状态
- **AND** 错误状态 SHALL 不包含敏感错误上下文正文

### Requirement: 多 profile 聚合为单一悬浮球

系统 SHALL 在多 profile 同时运行时仅显示一个桌面悬浮球，并在悬浮球中聚合所有 profile 的状态。

#### Scenario: 多 profile 同时运行

- **WHEN** 本机同时运行两个或更多 profile
- **THEN** 桌面 SHALL 只显示一个悬浮球
- **AND** 悬浮球 SHALL 使用聚合状态表示所有 profile 中最需要关注的状态

#### Scenario: hover 展开所有 profile

- **WHEN** 鼠标移动到悬浮球上
- **THEN** 悬浮球 SHALL 左右展开 profile 状态列表
- **AND** 列表 SHALL 展示每个可见 profile 的名称和当前状态
- **AND** 列表 SHALL 保持在当前屏幕可见区域内

#### Scenario: 鼠标移出后收起

- **WHEN** 鼠标离开悬浮球及其展开区域
- **THEN** profile 状态列表 SHALL 收起
- **AND** 桌面 SHALL 继续只显示聚合悬浮球

### Requirement: 悬浮球可拖动并持久化位置

桌面悬浮球 SHALL 支持用户拖动，并记住最后放置的位置。

#### Scenario: 用户拖动悬浮球

- **WHEN** 用户拖动悬浮球到屏幕上的新位置
- **THEN** 悬浮球 SHALL 跟随鼠标移动
- **AND** 系统 SHALL 保存新位置

#### Scenario: 重启后恢复位置

- **WHEN** 用户已拖动并保存悬浮球位置
- **AND** 悬浮球 helper 重启
- **THEN** 悬浮球 SHALL 恢复到上次保存的位置

#### Scenario: 保存位置超出当前屏幕

- **WHEN** 上次保存的位置不在当前屏幕可见区域内
- **THEN** 悬浮球 SHALL 移动到当前主屏幕的可见安全位置

### Requirement: 状态快照不得包含敏感内容

bridge SHALL 只向桌面悬浮球发布展示所需的低敏状态字段，不得写入用户消息、agent 输出、工具 payload 或凭据。

#### Scenario: 写入状态快照

- **WHEN** bridge 更新桌面状态快照
- **THEN** 快照 SHALL 包含 profile 名称、bot 显示名、agent 类型、状态、更新时间和必要的计数字段
- **AND** 快照 SHALL NOT 包含用户消息正文、prompt、assistant 输出、工具输入输出、sessionId、threadId、chatId、senderId、app secret 或 token

#### Scenario: 悬浮球读取状态快照

- **WHEN** 桌面悬浮球读取状态快照
- **THEN** 悬浮球 SHALL 只根据快照中的状态字段更新 UI
- **AND** 悬浮球 SHALL NOT 直接读取 bridge 会话历史或 agent 工具输出文件

### Requirement: 悬浮球失败不影响 bridge 核心功能

悬浮球启动、读取或渲染失败 SHALL NOT 阻断 bridge 后台服务、WS 连接或 agent run。

#### Scenario: helper 启动失败

- **WHEN** macOS 桌面悬浮球 helper 启动失败
- **THEN** bridge SHALL 记录 warning
- **AND** bridge SHALL 继续启动并监听消息

#### Scenario: 状态快照写入失败

- **WHEN** bridge 写入桌面状态快照失败
- **THEN** bridge SHALL 记录 warning
- **AND** 当前 agent run SHALL 继续执行

#### Scenario: helper 运行中崩溃

- **WHEN** 桌面悬浮球 helper 在运行中崩溃
- **THEN** bridge SHALL 继续写入状态快照或忽略快照写入失败
- **AND** bot 消息处理 SHALL 不受影响
