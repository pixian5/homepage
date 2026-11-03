# 持续研发第 8 轮：app.js 侧边栏与全局 Toast 体系解耦（toast-manager & sidebar-manager）（26.9.1）

> 模型：Claude Opus 5 ｜ 日期：2026-11-04 04:23 ｜ 版本：26.9.0 → 26.9.1

## 一、抽离 `src/js/toast-manager.js`（98 行）

- `createToastManager({ containerEl, getDurationMs, durationMs })`：
  - **`toast(message, actionLabelOrType, actionOrType, type)` 签名与既有用法 100% 向前兼容**——四种调用形态全支持（纯文本 / 第 2 参类型 / 动作标签+回调 / 四参带类型），非法类型串按动作标签处理；
  - ARIA：`role="status"`，error 级 `aria-live="assertive"`、其余 `polite`；
  - 动作按钮点击**立即执行回调并清除 Toast**；自动消失时长动态优先（`getDurationMs` 读设置）→ 固定值 → 5s 默认；多条并存平滑追加；容器缺失安全跳过；
- app.js 保留 `toast()` 一行薄包装（全文件与 modal/drag/selection 等子组件注入沿用旧名）；`toastMgr` 在模块加载即创建（任何时点的 toast 调用可用）。

## 二、抽离 `src/js/sidebar-manager.js`（129 行）

- `createSidebarManager(deps)`：
  - `applySidebarState()`：body `.sidebar-collapsed` / `.sidebar-hidden` 类名切换 + 折叠按钮文案（展开/收起）；
  - `syncSidebarTabLabels()`：折叠/展开态同步分组按钮 `aria-label` 与 `data-label`——**折叠时清空可见文本但保留可读名**（读屏可用）；
  - `renderGroups()`：固定根（全部书签，不可拖拽）+ 根目录顶层文件夹 Tab，激活分组 `active` 高亮、`data-short` 快捷序号、历史入口 `__recent__` 高亮；绑定点击切组（`setActiveGroup` + `closeFolder` + `lastActiveGroupId` + 持久化 + 重渲染）、右键分组菜单（固定根不触发）、drag-manager 投放绑定与 touch-drag 长按绑定透传、触摸拖拽后的点击抑制；
- app.js 2148 行：`applySidebarState` / `syncSidebarTabLabels` / `renderGroups` 三个函数删除，render/settings 注入全部经 `sidebarMgr.*`。

## 三、测试与验证（417 → 429，新增 12 项全过）

- `tests/toast-manager.test.js`（5 项）：默认 success 与 polite、四种兼容签名的类型解析、error assertive、动作按钮执行即清除、动态时长优先与固定回退、多条并存、容器缺失安全；
- `tests/sidebar-manager.test.js`（7 项）：body 类名与按钮文案状态机、折叠时文本清空但 aria 保留、固定根+文件夹 Tab 渲染与激活高亮与序号、draggable/触摸禁用差异、历史入口高亮互斥、点击切组全链路（active/lastActive/持久化/重渲染）、触摸抑制不切组、右键菜单仅普通分组。

**`npm test` 429/429 通过，`npm run check` Biome 零告警，`bundle-firefox` 门禁通过（两新模块按拓扑注册 + sw.js 预缓存清单同步补齐），三端构建成功（Safari.app 已装 /Applications），Chrome + Firefox 冒烟各 5 项全过。零外部依赖。**

顺带收获：PWA 预缓存一致性断言（第 7 轮测试）自动抓住了新模块需同步进 sw.js 清单——门禁自我生效。

## 四、八轮累计

| 指标 | 起始 | 当前 |
|---|---|---|
| app.js 行数 | 3435 | **2148**（-1287，-37.5%） |
| 抽出模块 | — | 13 个 |
| 测试 | 302 | 429 |

## 五、下一步

- app.js 剩余 2148 行：编辑弹窗（openEditModal 编排）、文件夹覆盖层（openFolder/closeFolder）、数据装载迁移——可再抽 2-3 个模块至 ~1800；
- 全链路 e2e：扩展 + Web/PWA 双形态的端到端同步回归脚本化。
