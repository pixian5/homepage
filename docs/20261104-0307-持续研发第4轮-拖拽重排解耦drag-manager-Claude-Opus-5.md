# 持续研发第 4 轮：app.js 拖拽与重排交互深度解耦（drag-manager）（26.8.5）

> 模型：Claude Opus 5 ｜ 日期：2026-11-04 03:07 ｜ 版本：26.8.4 → 26.8.5

## 一、抽离 `src/js/drag-manager.js`（解耦第四阶段）

**app.js：3052 → 2866 行（再 -186 行）**，新模块 345 行（加上删除的散落监听，拖拽相关净迁移约 340 行逻辑）。

### `createDragManager(deps)` 接口

- **状态**：`getDragState/setDragState`、`getDraggingGroupId/setDraggingGroupId`、`cleanupDragState`（清状态 + `.drop-target`/`.dragging` 悬停高亮）——触摸拖拽（touchDragState）仍留在 app.js，经这些接口与模块协同；
- **绑定**：
  - `bindTileDragEvents(tile, node)`：dragstart（记录源 + effectAllowed）/ dragover（**目标卡片 .drop-target 投放指示高亮**，拖拽源自身不高亮）/ dragleave 清除 / drop 分发 / dragend 清理；
  - `bindSidebarFolderEvents(btn, { groupId, fixedAllGroup })`：侧栏分组按钮的卡片投放（经 canMove 校验）+ 分组拖拽排序（dragstart/dragend/dragover 高亮/首尾容器滚动由 bindGroupTabsEvents 处理）；
  - `bindGridDropEvents(grid, { getContainer, enabled })`：主网格与文件夹覆盖层网格的空白区投放（几何最近矩形排序插入），`enabled` 回调承载历史分组禁投与上下文判断；
  - `bindGroupTabsEvents(tabsEl)`：侧栏容器边缘自动滚动 + 投放到首/尾；
- **三种拖拽意图统一在 `dropOnTile(targetId, x, y)`**：
  1. **排序插入**：非图标区按目标卡片左右半区判定（`moveNodeInList`，无变化时幂等跳过）；
  2. **放入已有文件夹**：图标区 + 目标是文件夹 → **`moveNodeToFolder`**（canMove 循环引用防护 + 全位置移除 + 追加）；
  3. **合并成组**：图标区 + 目标是普通卡片 → 注入的 `createFolderNode([targetId, sourceId])` 建夹并插到原目标位置；
- 几何判定复用 `drag-geometry.js` 纯函数（findNearestRect / shouldInsertAfter / isPointInsideRect / toPlainRect）。

### app.js 接线

renderGrid 卡片块、侧栏按钮块、grid/folderGrid/groupTabs 四组监听全部替换为 `dragManager.bind*` 一行调用；`handleDropOnTile`/`isDropOnIcon`/`getInsertIndexFromTarget`/`getTileElementById`/`getDropIndex`/`moveDraggedNodeToSidebarFolder`/`moveGroupBefore` 七个函数删除；`dragState`/`draggingGroupId` 模块变量移除（触摸代码改走 manager 接口）；drag-geometry 导入从 5 项精简到 1 项（nextGridFocusIndex）。

### 架构门禁

`drag-manager.js` 已在 `firefox-modules.json` 注册于 **drag-geometry.js 之后、app.js 之前**，`bundle-firefox` 拓扑校验 + 经典脚本断言通过（产物含全部新代码）。

## 二、测试与验证

新增 `tests/drag-manager.test.js` 10 项（353 → 363）：

- dragstart 状态与 effectAllowed、dragend 清理；dragover 指示高亮（自身除外）与 dragleave 清除；
- **排序插入**：右半区幂等（无变化不持久化）+ 左半区真实重排（placement 容器时钟推进、备份、持久化、重渲染）；
- **放入文件夹**：图标区投放 → children 追加 + 源引用移除 + 目标时钟 + toast（走真实 `moveNodeToFolder`）；
- **合并成组**：两卡入新夹、新夹插到原目标位、根列表更新；
- **历史分组禁投**：任何投放不落盘不建夹；
- **侧栏**：卡片投放经校验（校验失败不动）+ 分组排序 moveGroupBefore；容器首/尾投放 index 正确；
- **网格空白区**：几何最近矩形排序 + `enabled=false` 时清理不落盘。

实现中被测试先行纠正的两处：① 投放点落在图标矩形**底边**（边界判定含等号）会误入"放入文件夹"分支——测试坐标避开边界；② 文件夹意图最初手写移除/追加，按任务要求改为统一走 `moveNodeToFolder`（顺带获得循环引用防护）。

**`npm test` 363/363 通过，`npm run check` Biome 零告警，`bundle-firefox` 门禁通过，三端构建成功（Safari.app 已装 /Applications），Chrome + Firefox 冒烟各 5 项全过。零外部依赖。**

## 三、遗留与下一步

- 触摸拖拽（touchDragState 状态机，约 200 行）仍在 app.js，可作为第五阶段与框选（selectionBox）一起抽离；
- app.js 剩余 2866 行（距任务参考值 2700 的差值即触摸拖拽部分），后续抽离存储监听与数据装载（~300 行）可进一步降至 ~2300。
