# 持续研发第 9 轮：app.js 文件夹覆盖层与 Tooltip 体系解耦（folder-manager & tooltip-manager）（26.9.2）

> 模型：Claude Opus 5 ｜ 日期：2026-11-04 04:38 ｜ 版本：26.9.1 → 26.9.2

## 一、抽离 `src/js/folder-manager.js`（186 行）

- `createFolderManager(deps)`——`openFolderId` 真值仍由宿主持有（大量视图依赖），经 `getOpenFolderId/setOpenFolderId` 读写：
  - `openFolder(id)`：解除 inert、`aria-hidden=false`、标题更新、渲染并聚焦网格；
  - `closeFolder()`：**嵌套文件夹先回退父级**（标题与打开态保持），顶层关闭恢复 inert/aria-hidden，覆盖层内焦点交还设置按钮（键盘漫游不中断）；
  - `isFolderOpen()` / `getOpenFolderId()`；
  - `renameFolder(id, newTitle)`：校验（存在/类型/非空/有变化）拒绝路径**不推进时钟不落盘**；成功路径 `stampNodeFieldChanges({titleChanged})` + 持久化 + 渲染；app.js 的 `renameGroup`（prompt 交互）变薄壳调用它；
  - `dismissFolder(id)`：子项**依序平填回原位置**（分组根 → 父文件夹 → 活动分组兜底三级回退）+ `markNodeDeleted` + 时钟推进 + toast；
  - `bindOverlayEvents()`：返回 / 解散 / 空白点击关闭；
- app.js：`openFolder/findParentFolderId/closeFolder/dissolveFolder` 四函数删除，`openFolder/closeFolder` 保留薄包装（tile 点击、Escape、context-menu 等大量调用点沿用旧名），context-menu 的解散回调改经 `folderMgr.dismissFolder`。

## 二、抽离 `src/js/tooltip-manager.js`（77 行）

- `createTooltipManager({ tooltipEl, delayMs, isEnabled, getViewport })`：
  - `scheduleShow(text, x, y)`：防抖（默认 200ms）**重复悬停重置计时**，鼠标滑过多卡片不闪烁；
  - `showTooltip`：文本 + `translate3d` 定位（右下偏移 12px）+ **视口防越界钳制**（保留 8px 边距——新增能力，原实现无越界处理）；
  - `hideTooltip`：即时隐藏并清除待显示定时器；`isEnabled` 开关拦截（含立即显示路径）；
- app.js：`tooltipTimer` 模块变量与 `TOOLTIP_DELAY_MS` 常量删除，tile mouseenter/mouseleave 改两行 manager 调用。

## 三、测试与验证（429 → 442，新增 13 项全过）

- `tests/folder-manager.test.js`（8 项）：展开（inert/aria/标题/聚焦）、嵌套回退父级与顶层关闭、焦点交还、事件绑定（空白关闭/解散先关闭再回填）、重命名四类拒绝与时钟推进、解散三级回填（分组根原位/父文件夹原位/活动分组兜底）与非文件夹拒绝；
- `tests/tooltip-manager.test.js`（5 项）：防抖窗口与到点显示、重复悬停重置计时且显示最后内容、右/下越界钳制（8px 边距）与未越界原样偏移、hide 取消待显示定时器、disabled 拦截两条路径。

**`npm test` 442/442 通过，`npm run check` Biome 零告警，`bundle-firefox` 门禁通过（两新模块按拓扑注册 + `sw.js` 预缓存清单同步），三端构建成功（Safari.app 已装 /Applications），Chrome + Firefox 冒烟各 5 项全过。零外部依赖。**

## 四、九轮累计与里程碑说明

**app.js 2148 → 2080 行**（本轮 -68）。任务预期"破 1900"基于"文件夹 180+ 行、tooltip 60+ 行"的预估；实测两块在 app.js 的净占位约 120 行（文件夹逻辑主体早已在 drag-manager 共用依赖中，tooltip 核心仅 30 行），加上薄包装与工厂接线的必要回增，本轮净减 68 行。**九轮累计 3435 → 2080（-1355，-39.4%），15 个高内聚模块，测试 302 → 442。** 下一步抽离编辑弹窗（openEditModal 编排 ~250 行）与渲染管线（renderGrid 主体 ~300 行）可破 1600。

## 五、下一步

- 编辑弹窗编排器（表单/校验/图标抓取联动）；
- renderGrid 纯视图层抽离（布局计算已有几何模块基础）；
- 扩展 + Web/PWA 双形态端到端同步回归脚本化。
