# 持续研发第 5 轮：app.js 存储热监听与触摸拖拽解耦 + 墓碑回收 launchd 常态守护（26.8.6）

> 模型：Claude Opus 5 ｜ 日期：2026-11-04 03:25 ｜ 版本：26.8.5 → 26.8.6

## 一、抽离 `src/js/storage-listener.js`（158 行）

- `createStorageListener(deps)`：**双通道监听**——扩展 `chrome.storage.onChanged` + Web 模式 `window "storage"` 事件（跨标签页热同步，第 3 轮 Web 回退的最后一块拼图）；
- **自身写入防循环**：写入窗口期（persistInFlight）/ 抑制期（suppressStorageUntil）/ 时间戳回声（incoming ≤ local）三层判定；
- **分流**：同步状态/队列键（SYNC_STATE_KEY/SYNC_OUTBOX_KEY）→ 刷新提示条不重载；核心数据键 → 防抖 120ms 安全重载（reload 回调注入，reloadFromStorage 保留在 app.js）；
- **设置弹窗挂起**：打开期间外部变更挂起（`hasPendingReload`），关闭后 `flushPendingReload()` 补一次——原散落在 modal 关闭回调里的 pendingStorageReload 逻辑内聚；
- `bind()` 返回 dispose（先卸后绑，幂等），解绑逻辑统一内聚。

app.js：`attachStorageListener`/`scheduleStorageReload`/`storageReloadTimer`/`pendingStorageReload` 全部删除，modal 关闭回调改一行 `storageListener?.flushPendingReload()`。

## 二、抽离 `src/js/touch-drag-manager.js`（414 行）

- `createTouchDragManager(deps)`：完整触摸状态机——卡片 3000ms / 分组 260ms 长按激活、1s 长按上下文菜单、等待期滑动取消（18px 阈值）、拖动中 `document.elementFromPoint` 拾取 tile/分组按钮并维护悬停高亮、源卡片位移跟随、松手分发三种 drop 意图（侧栏文件夹 / 卡片投放 / 空白区几何排序）、拖拽后 400ms 点击抑制；
- 与 drag-manager 深度联动：`setDragState`/`setDraggingGroupId`/`cleanupDragState`/`getDropIndex`/`dropOnTile`/`moveDraggedNodeToSidebarFolder`/`moveGroupBefore`；
- 接口：`bindTileTouchEvents`（renderGrid 逐卡）、`bindGroupTouchEvents`（侧栏）、`bindDocumentTouchEvents`（init 一次）、`isClickSuppressed()`、`reset()`、`isActive`/`mode` 只读；
- **测试先行抓到并修复一个我引入的时序缺陷**：先设菜单计时器再 beginLongPress 会被内部重置清掉——对照 git 原实现纠正为"先长按计时后菜单计时"。

**app.js：2866 → 2558 行（-308，达成任务 2500 左右目标）**；touchDragState/touchMenuState 两个状态对象、5 个触摸常量、12 个函数、3 组 document 监听全部移除。

## 三、`scripts/setup-tombstone-reclaim.sh`（launchd 常态守护）

- 动作：`install [--force|--dry-run] [--hour HH:MM] [--url URL] [--token TOKEN]` / `uninstall` / `status`；
- 生成 `~/Library/LaunchAgents/com.homepage.tombstone-reclaim.plist`：StartCalendarInterval 每日定时（默认 03:30 dry-run，可 --force）、程序为 run-tombstone-reclaim.sh、日志 `~/Library/Logs/homepage/tombstone-reclaim.log`、`RunAtLoad=false`（装载即跑会立刻打一轮 API）；Token 同步写入 env 文件并收紧 600 权限；幂等安装（先 unload 再 load）；macOS bash 3.2 兼容；
- **可测试性**：`LAUNCHCTL_BIN` 环境变量可注入假 launchctl——测试全程不触碰真实用户会话。

## 四、测试与验证（363 → 385，新增 22 项全过）

- `tests/storage-listener.test.js`（8 项）：同步键分流不重载、时间戳回声忽略、写入窗口/抑制期/非 local 忽略、防抖合并单次重载、dispose 停止响应、Web storage 事件（跨标签更新/回声/其它键/坏 JSON 兜底）、window 绑定与解绑、设置挂起与 flush；
- `tests/touch-drag-manager.test.js`（9 项）：3s/260ms 长按激活与 dragState 联动、elementFromPoint 拾取与高亮维护/清除、源卡片位移跟随、touchend 三种 drop 意图（卡片/侧栏文件夹/空白区排序持久化）、分组 moveGroupBefore、1s 上下文菜单、点击抑制；
- `tests/setup-tombstone-reclaim.test.js`（5 项）：install 生成 plist 全字段断言 + env 权限 600 + 幂等（unload→load）、dry-run/03:30 默认、status、uninstall 清理与未安装退出码 2、非法动作/参数/时间退出码 1。

**`npm test` 385/385 通过，`npm run check` Biome 零告警（含 forEach 回调返回值检查），`bundle-firefox` 拓扑门禁通过，三端构建成功（Safari.app 已装 /Applications），Chrome + Firefox 冒烟各 5 项全过。零外部依赖。**

## 五、成果与下一步

| 指标 | 值 |
|---|---|
| app.js 行数 | 2866 → **2558**（五轮累计 3435 → 2558，-877 / -25.5%） |
| 新模块 | storage-listener 158 行 + touch-drag-manager 414 行 |
| 测试 | 363 → 385 |

下一步可继续：框选（selectionBox ~150 行）、设置应用管线（applyTheme/applyDensity ~200 行）抽离，以及把 launchd 守护接到真实服务器跑一次 `--force` 演练。
