# 我的首页（Chrome / Firefox / Safari 新标签页扩展）

> 本文档基于当前仓库源码（`src/` + `scripts/` + `manifest.*.json`）整理，重点是“实现现状”而不是需求设想。

## 1. 项目定位

这是一个浏览器扩展，用来替换浏览器新标签页，提供可维护的快捷入口面板，支持：

- 新标签页接管（Chrome MV3 / Firefox MV3 / Safari Web Extension）
- 分组与文件夹管理
- 快捷卡片增删改查、拖拽排序
- 最近历史页（读取浏览器历史）
- 图标自动抓取与缓存
- 每日 Bing 背景（含缓存回退）
- 本地存储 + 可选同步存储
- 导入导出、备份与恢复
- Popup 一键保存当前网页到分组

## 2. 功能总览（按已实现代码）

> 各功能的具体代码位置见**第 16 章 开发者地图**。

### 2.1 新标签页主界面

- 顶部工具栏：新增、批量删、打开方式切换、设置、搜索。
- 左侧分组栏：历史、分组列表、新增分组、收起按钮。
- 主区域网格：卡片展示 + 拖拽排序。
- 文件夹覆盖层：进入文件夹后可继续增删/批量删/解散。
- 右键菜单：卡片操作、分组操作。
- Toast / Tooltip：操作反馈与悬停提示。

### 2.2 卡片能力

- 支持类型：
  - `item`（普通网址卡片）
  - `folder`（文件夹）
  - `history`（历史页临时卡片，不持久化）
- 打开方式：本页 / 新页 / 后台（通过按钮循环切换）。
- 卡片新增支持：
  - 手工输入 URL
  - 从当前标签页读取 URL + 标题
  - 图标来源：自动、上传、颜色头像、远程 URL
- 编辑支持：标题、URL、图标来源。
- 删除支持：单个、批量；支持撤销（10 秒窗口）。

### 2.3 分组 / 文件夹

- 分组可新增、重命名、删除、拖拽排序。
- 卡片可拖到另一卡片图标上创建文件夹。
- 卡片可拖入现有文件夹图标。
- 文件夹可解散，子项回填原位置。
- 支持文件夹内继续拖拽排序。

### 2.4 历史页

- “历史”分组来自 `chrome.history.search` / `browser.history.search`。
- 最近天数：7 天。
- 最大条目：24。
- 按 URL 去重。
- 历史项支持“添加到快捷”（可选分组）。

### 2.5 搜索

- 顶部输入框即时过滤当前网格中的卡片标题/URL。
- Enter 或搜索按钮会使用当前搜索引擎打开新页面搜索。

### 2.6 设置

已实现设置项：

- 顶部搜索框显示开关
- 搜索引擎预设/自定义
- 固定列数 + 列数
- 网格密度（紧凑/标准/宽松）
- 背景类型（Bing/纯色/渐变/自定义图）
- 背景遮罩强度
- 语言（简体中文/繁體中文/English/日本語/한국어/Deutsch/Français/Español）
- Tooltip、键盘导航
- 主题（system/light/dark）
- 字体大小
- 默认保存分组（上次分组/固定分组）
- 侧边栏隐藏
- 同步开关
- 最大备份数量
- 图标失败重试时间点（0~23 点或关闭）

## 3. 架构与模块

## 3.1 运行时结构

- 新标签页入口：`src/newtab.html` -> `src/js/app.js`
- Popup 入口：`src/popup.html` -> `src/popup.js`
- 内容提示脚本：`src/js/content-toast.js`

## 3.2 核心模块

| 模块 | 文件 | 核心功能 / 主要导出 |
|------|------|-------------------|
| 主应用 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `init()`、`render()`、`persistData()`、`pushBackup()`、`importData()`、拖拽与文件夹、模态框、设置面板 |
| 存储层 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `loadData()`、`saveData()`、`clearData()`、`defaultData()`、`sanitizeForSync()`、`handleQuotaError()`、`migrateData()`、`deepClone()` |
| 图标系统 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `resolveIcon()`、`getFaviconCandidates()`、`refreshAllIcons()`、`preloadAllIcons()`、`probeImage()`、`generateLetterIcon()` |
| Bing 背景 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `fetchBingWallpaper()`、`getCachedWallpaper()`、`setCachedWallpaper()` |
| Popup | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `init()`、`getCurrentTab()`、`saveCurrentPage()` |
| 内容 Toast | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js) | `showToast()`、`onMessage` 监听、`__homepageToastInjected` 守卫 |
| 错误兜底 | [src/js/error-bootstrap.js](file:///Users/x/code/homepage/src/js/error-bootstrap.js) | ESM 加载失败检测 + 兜底错误提示（内联于 newtab.html head） |

> 各功能的详细代码位置见**第 16 章 开发者地图**。

## 3.3 构建模块

| 模块 | 文件 | 核心功能 / 主要导出 |
|------|------|-------------------|
| 主构建脚本 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | 三端资源复制、manifest 写入、zip/xpi 打包、Safari 转换与签名、版本号自增调用 |
| Firefox ESM 打包 | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs) | `stripImports()` / `stripExports()` / `bundle()` / `patchHtml()`，合并多 ESM 为单文件外部脚本 |
| 版本号自增 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs) | `bumpVersion()` / `run()`，+0.1 满十进一，同步更新 4 个 manifest 文件 |
| macOS 一键构建 | [scripts/build-macos.command](file:///Users/x/code/homepage/scripts/build-macos.command) | 调用 build.sh + Xcode Release 构建 + 开发签名 + 安装到 /Applications + lsregister 去重 |

## 4. 目录说明

```text
src/
  assets/                图标资源（16/32/48/128）
  newtab.html            新标签页主界面
  styles.css             新标签页样式
  popup.html             Popup 页面
  popup.css              Popup 样式
  popup.js               Popup 逻辑
  js/
    app.js               主应用逻辑
    storage.js           存储层
    icons.js             图标策略与缓存
    bing-wallpaper.js    Bing 背景获取与缓存
    content-toast.js     页面内 toast
    error-bootstrap.js   加载失败兜底提示

manifest.chrome.json     Chrome Manifest V3 模板
manifest.firefox.json    Firefox Manifest V3 模板
manifest.safari.json     Safari Manifest V3 模板
scripts/
  build.sh               主构建脚本（bash）
  build-macos.command    macOS 一键构建入口（含 Safari App 签名与安装）
  bundle-firefox.mjs     Firefox ESM 合并为外部脚本
  bump-version.mjs       自动版本号递增
tests/                   单元测试（storage / icons / bing-wallpaper / bump-version / bundle-firefox）
.github/workflows/       GitHub Actions CI 配置
```

## 5. 数据模型（存储结构）

存储主键：`homepage_data`

```json
{
  "schemaVersion": 1,
  "settings": {},
  "groups": [],
  "nodes": {},
  "backups": [],
  "lastUpdated": 0
}
```

**读写入口**：

| 操作 | 函数 | 文件 |
|------|------|------|
| 读取数据 | `loadData()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L200-L276) |
| 写入数据 | `saveData()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L382-L437) |
| 清空数据 | `clearData()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L362-L392) |
| 默认数据 | `defaultData()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L125-L170) |
| 持久化触发 | `persistData()`（UI 层入口，含指纹对比 + 备份） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1228-L1300) |
| 数据迁移 | `migrateData()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L277-L328) |

## 5.1 `groups`

- 结构：`{ id, name, order, nodes: string[] }`
- `nodes` 保存节点 ID 顺序。

**操作入口**：

| 操作 | 函数 / 位置 | 文件 |
|------|------------|------|
| 新增分组 | `btnAddGroup` 点击事件（内联逻辑） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3849-L3856) |
| 重命名分组 | `renameGroup(group)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2164-L2171) |
| 删除分组 | `deleteGroup(group)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2172-L2183) |
| 分组建模 | `groups` 数组 | `data.groups`（顶层字段） |

## 5.2 `nodes`

### item

```json
{
  "id": "itm_xxx",
  "type": "item",
  "title": "示例",
  "url": "https://example.com/",
  "iconType": "auto|upload|color|remote|letter",
  "iconData": "",
  "color": "",
  "titlePending": false,
  "iconPending": false,
  "createdAt": 0,
  "updatedAt": 0
}
```

### folder

```json
{
  "id": "fld_xxx",
  "type": "folder",
  "title": "新建文件夹",
  "children": ["itm_xxx", "itm_yyy"],
  "createdAt": 0,
  "updatedAt": 0
}
```

**操作入口**：

| 操作 | 函数 / 位置 | 文件 |
|------|------------|------|
| 新增卡片 | `openAddModal()` → 保存逻辑 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2282-L2458) |
| 编辑卡片 | `openEditModal(node)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2459-L2626) |
| 删除节点 | `deleteNodes(ids)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2184-L2212) |
| 创建文件夹（拖到卡片图标） | `handleDropOnTile()` 内的图标分支 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1968-L2038) |
| 解散文件夹 | `dissolveFolder(folderId)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2040-L2080) |
| 打开文件夹覆盖层 | `openFolder(folderId)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1577-L1597) |
| 关闭文件夹覆盖层 | `closeFolder()` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1598-L1610) |
| 节点存储 | `nodes` 对象（按 ID 索引） | `data.nodes`（顶层字段） |

## 5.3 `settings` 字段说明

- `language`: 界面语言（空 = 跟随系统）
- `showSearch`: 显示顶部搜索框
- `enableSearchEngine`: 保留字段（当前逻辑固定为 `true`）
- `searchEngineUrl`: 搜索引擎前缀
- `openMode`: `current|new|background`
- `fixedLayout`: 固定列数开关
- `fixedCols`: 固定列数
- `gridDensity`: `compact|standard|spacious`
- `fontSize`: 基础字体大小
- `tooltipEnabled`: 提示开关
- `emptyHintDisabled`: 空状态提示关闭
- `backgroundType`: `bing|color|gradient|custom`
- `backgroundColor`: 纯色背景值
- `backgroundGradient`: 渐变字符串
- `backgroundGradientA/B`: 渐变两色
- `backgroundCustom`: 自定义背景 DataURL
- `backgroundFade`: 保留字段（当前无单独行为）
- `backgroundOverlayStrength`: 图片背景遮罩强度
- `iconFetch`: 自动图标抓取
- `iconRetryAtSix`: 兼容字段（18 点重试）
- `iconRetryHour`: 重试小时（0~23 或空）
- `syncEnabled`: 是否启用 `storage.sync`
- `maxBackups`: 最大备份数（0 代表不自动备份）
- `keyboardNav`: 键盘导航开关
- `lastActiveGroupId`: 上次激活分组
- `defaultGroupMode`: `last|fixed`
- `defaultGroupId`: 固定分组 ID
- `theme`: `system|light|dark`
- `lastSaveUrl/lastSaveTs/lastSaveToast`: popup 保存辅助字段
- `sidebarCollapsed`: 左侧栏压缩态
- `sidebarHidden`: 左侧栏隐藏态

## 5.4 其他存储键

| 存储键 | 存储位置 | 用途 | 读写入口 |
|--------|---------|------|---------|
| `homepage_icon_cache` | `chrome.storage.local` | 图标 dataURL 缓存（URL 维度 + site 根域维度） | `loadIconCache()` / `saveIconCache()`（[src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js)） |
| `homepage_bg_cache` | `chrome.storage.local` | Bing 背景缓存（按日期 key，6 小时 TTL） | `getCachedWallpaper()` / `setCachedWallpaper()`（[src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js)） |
| `homepage_save_log` | `chrome.storage.local` | Popup 保存操作日志 | popup.js 内读写 |
| `homepage_debug_log` | `localStorage` | 调试日志（仅 DEBUG 模式写入） | `homepageDebugLog()` / `homepageDebugEnv()` |

## 6. 关键流程

## 6.1 初始化

`init()` 流程（位于 [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3742-L3810)）：

1. 绑定 runtime 消息与 storage 监听。
2. 读取本地数据；若启用同步则比较 `lastUpdated` 选择更新者（`loadData()` 在 [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L200-L276)）。
3. 执行去重修复（分组节点/文件夹子节点）（`deduplicateAll()` 在 [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2098-L2148)）。
4. 恢复上次分组、载入最近历史（`loadRecentHistory()` 在 [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3535-L3570)）。
5. 应用密度、主题、侧栏状态（`applyDensity()` / `applyTheme()` / `applySidebarState()`）。
6. 加载背景（Bing/本地设置）（`loadBackground()` 在 [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1099-L1130)）。
7. 尝试图标定时重试（`retryFailedIconsIfDue()` 在 [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js)）。
8. 首次渲染（`render()` 在 [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L927-L978)）。

## 6.2 持久化 `persistData()`

实现位置：[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1228-L1300)

- 保存前自动对比指纹（`computeDataFingerprint()`），必要时先生成备份快照（`pushBackup()`）。
- 根据 `syncEnabled` 写入 `sync` 或 `local`（`saveData()` 在 [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L382-L437)）。
- 若同步开启，会额外写本地副本。
- 写入后再次去重并二次保存（如有必要）。
- 返回 `{ ok, warning, err }`，由 UI 给出 toast。

## 6.3 删除与撤销

| 功能 | 函数 / 变量 | 位置 |
|------|------------|------|
| 删除节点（单个/批量） | `deleteNodes(ids)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2184-L2212) |
| 删除分组 | `deleteGroup(group)` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2172-L2183) |
| 撤销删除 | `undoDelete()` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2206-L2211) |
| 待删除快照 | `pendingDeletion` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L115) |
| 撤销窗口时长 | `UNDO_TIMEOUT_MS` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L176) |

流程说明：
- 删除前会 `pushBackup()`（备份快照，[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1136-L1140)）。
- 删除后保留 `pendingDeletion` 快照，toast 显示"撤销"，可回滚。
- 撤销窗口：10 秒（`UNDO_TIMEOUT_MS = 10000`），超时后自动清除快照。

## 6.4 拖拽与文件夹规则

| 规则 | 实现位置 |
|------|---------|
| 鼠标拖拽开始/结束 | `handleCardDragStart` / `handleDropOnTile`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1968-L2038)） |
| 触摸长按拖拽 | `TOUCH_TILE_LONG_PRESS_MS`（3秒）+ touch 事件组（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1685-L1740)） |
| 拖到卡片图标创建/加入文件夹 | `handleDropOnTile()` 内的 `droppedOnIcon` 分支（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1978-L2038)） |
| 拖到卡片非图标区域插入 | 左右半区计算插入位置（`getInsertIndexFromTarget()`） |
| 文件夹解散 | `dissolveFolder(folderId)`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2040-L2080)） |
| 文件夹覆盖层 | `openFolder()` / `closeFolder()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1577-L1610)） |
| 框选（鼠标拖拽选多个） | `handleBoxSelectStart` / `handleBoxSelectMove`（raf 节流） / `handleBoxSelectEnd` |

## 6.5 触摸交互

| 交互 | 常量 / 函数 | 位置 |
|------|------------|------|
| 卡片长按 3 秒进入拖拽 | `TOUCH_TILE_LONG_PRESS_MS` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1700) |
| 卡片触摸 1 秒弹上下文菜单 | `TOUCH_TILE_CONTEXT_MENU_MS` + `touchMenuState` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) |
| 分组长按 260ms 进入拖拽 | `TOUCH_GROUP_LONG_PRESS_MS` | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L675-L695) |

## 6.6 popup 保存当前页

实现位置：[src/popup.js](file:///Users/x/code/homepage/src/popup.js)

- 若设置为固定分组（`defaultGroupMode === "fixed"`），打开 popup 时直接保存并关闭窗口（[src/popup.js](file:///Users/x/code/homepage/src/popup.js#L600-L620)）。
- 否则展示当前标签页信息 + 分组选择，下发保存。
- 获取当前标签页：`getCurrentTab()`（含 `chrome.runtime.lastError` 检查）。
- 保存后优先向当前页面注入 toast（消息通信 + 内容脚本兜底）。
- 内容脚本：[src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js)（含 `__homepageToastInjected` 注入守卫）。

## 7. 同步与配额策略

## 7.1 同步选择策略

实现位置：`loadData()` 函数内的 `syncSelection` 分支（[src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L200-L276)）

- 本地与同步同时存在时按 `lastUpdated` 选最新。
- 只有一侧有数据时直接使用。
- 数据加载后会执行一次去重修复。

## 7.2 同步数据清洗（`sanitizeForSync`）

实现位置：[src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L330-L380)

写 `storage.sync` 前会去除高体积字段（`SYNC_ITEM_QUOTA = 7500` 字节阈值）：

- `backups` 清空
- `backgroundCustom` 清空（自定义背景）
- 过长上传图标改为自动（`ICON_DATA_MAX_LENGTH` 阈值）

## 7.3 配额与降级处理

| 场景 | 处理函数 | 位置 |
|------|---------|------|
| 同步超限自动降级 | `saveData()` 内的 quota 检查 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L382-L437) |
| 本地写入 quota 错误逐级清理 | `handleQuotaError()` | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L439-L506) |

清理顺序：

1. 清理备份（`backups` 数组清空）
2. 清理上传图标（`iconType: upload` 改为 `auto`）
3. 清理自定义背景（`backgroundCustom` 清空）

同步目标大小阈值：`7500` bytes（Chrome sync 单条限制约 8KB）。
超限：自动关闭同步（`syncEnabled = false`），回退本地存储。

## 8. 图标与背景

## 8.1 favicon 候选顺序

实现位置：`getFaviconCandidates()`（[src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js#L101-L200)）

根据域名生成候选（优先级从高到低）：

- 特殊站点预设（如 Gmail/Google/OpenAI/ChatGPT，硬编码在 `SPECIAL_SITES`）
- 站点自身 `origin/favicon.ico`
- Google S2 favicon API（多种尺寸变体）
- DuckDuckGo 图标源

注意：Chrome 和 Safari/Firefox 的候选顺序略有不同（Safari/Firefox 优先站点自身 favicon.ico）。

## 8.2 图标缓存

实现位置：[src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js)

- **内存缓存**：`_iconCacheMemory`（首次 `loadIconCache()` 后常驻内存，避免渲染循环多次 IO）
- **持久化存储 key**：`homepage_icon_cache`（`chrome.storage.local`）
- **缓存维度**：URL 维度缓存 + `site:根域` 维度缓存（两套 key）
- **缓存格式**：dataURL（非远程 URL，确保离线秒开）
- **非 http(s) URL**：回退字母头像，并清理 URL 缓存
- **尺寸校验**：`probeImage()` 加载后验证 `naturalWidth/naturalHeight ≥ 16`，小于 16 像素的图标丢弃
- **批量刷新**：`refreshAllIcons()` 6 并发
- **预加载优化**：`preloadAllIcons()` 单次读取全部缓存，渲染时传 `preloadedCache` 参数

## 8.3 背景缓存

实现位置：[src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js)

- **存储 key**：`homepage_bg_cache`（`chrome.storage.local`）
- **缓存 key**：当日日期字符串（同日只请求一次）
- **TTL**：6 小时（`MAX_CACHE_AGE`）
- **三级降级**：Bing API 请求 → 读缓存 → 纯色背景
- **应用入口**：`loadBackground()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1099-L1130)）

## 9. 设置、导入导出与备份

## 9.1 导出设置

实现位置：`openManualExportModal()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3045-L3068)）

- 优先写剪贴板（`navigator.clipboard.writeText()`）。
- 失败时弹文本框手工复制（`showToast` 提示）。

## 9.2 导入设置

实现位置：`openImportModal()` + `importData()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3088-L3160)）

支持三种策略：

- **覆盖所有（replace）**：直接替换数据对象。
- **合并现有（merge）**：
  - 节点按 ID 补缺。
  - 分组同 ID 同名 → 合并节点列表；同 ID 异名 → 自动改 ID 新建分组。
- **仅新增（add）**：已有 ID 跳过，不覆盖。

导入 JSON 仅检查 `schemaVersion`，不做严格 schema 校验。

## 9.3 批量导入网址

实现位置：`openImportUrlModal()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3179-L3276)）

- 每行一个网址（取每行首 token，自动跳过空行和注释）。
- 可选择按 `http://` 或 `https://` 规范化导入。
- 统计并提示无效条目数。
- 导入后自动刷新图标。

## 9.4 备份管理

| 功能 | 实现位置 |
|------|---------|
| 打开备份面板 | `openBackupModal()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3277-L3338)） |
| 创建备份快照 | `createBackupSnapshot()`（[src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L330-L360)） |
| 推入备份队列 | `pushBackup()`（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1136-L1152)） |
| 自动备份触发 | `persistData()` 内的指纹比较（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1228-L1300)） |
| 恢复备份 | `openBackupModal()` 内的 `.backup-restore` 点击处理（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3293-L3323)） |
| 删除备份 | `openBackupModal()` 内的 `.backup-delete` 点击处理（[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3325-L3336)） |
| 最大备份数 | `maxBackups` 设置（0 = 不自动备份） |

## 10. 权限与外部请求

## 10.1 权限

| 权限 | 声明位置 | 用途 | 使用位置 |
|------|---------|------|---------|
| `storage` | Chrome / Firefox / Safari | 数据持久化（local + sync） | `storage.js` 全部读写操作 |
| `tabs` | Chrome / Firefox / Safari | Popup 获取当前标签页、后台取标题 | `popup.js` 的 `getCurrentTab()` |
| `activeTab` | Chrome / Firefox / Safari | 用户触发时临时访问当前标签页 | `popup.js` 保存时注入 toast |
| `history` | Chrome / Firefox（Safari 不声明） | 读取最近历史记录 | `app.js` 的 `loadRecentHistory()` |
| `scripting` | Chrome / Firefox MV3 / Safari | 注入内容脚本（toast 提示） | `popup.js` 保存后注入 `content-toast.js` |
| `<all_urls>` | Chrome / Firefox / Safari | favicon 抓取、内容脚本注入覆盖面 | `icons.js`、`content-toast.js` |

各浏览器 manifest：
- Chrome: [manifest.chrome.json](file:///Users/x/code/homepage/manifest.chrome.json)
- Firefox: [manifest.firefox.json](file:///Users/x/code/homepage/manifest.firefox.json)
- Safari: [manifest.safari.json](file:///Users/x/code/homepage/manifest.safari.json)

## 10.2 外部请求

| 请求源 | 地址 | 用途 | 代码位置 |
|--------|------|------|---------|
| Bing 壁纸 API | `https://www.bing.com/*` | 每日壁纸获取 | `bing-wallpaper.js` 的 `fetchBingWallpaper()` |
| Google S2 favicon | `https://www.google.com/s2/favicons` | favicon 抓取备选源 | `icons.js` 的 `getFaviconCandidates()` |
| DuckDuckGo 图标 | `https://icons.duckduckgo.com` | favicon 抓取备选源 | `icons.js` 的 `getFaviconCandidates()` |
| 目标站点 favicon | 各站点 `favicon.ico` | 站点自身图标（优先） | `icons.js` 的 `getFaviconCandidates()` |

CSP 配置：`connect-src * https: http:`（允许任意 favicon 源和 Bing API）。

## 11. 构建与发布

补充文档：

- Safari 专项说明见 [Safari说明.md](/Users/x/code/homepage/Safari说明.md)

## 11.1 前置条件

- Node.js（用于脚本）
- Bash（`npm run build` 调用 `scripts/build.sh`）
- zip 工具（`build.sh` 使用 `zip`）
- macOS 构建 Safari 宿主 App 时需安装 Xcode（使用 `xcrun safari-web-extension-converter` 与 `xcodebuild`）

## 11.2 构建命令

```bash
npm run build
```

或在 macOS 直接运行项目内构建入口：

```bash
NO_PAUSE=1 ./scripts/build-macos.command
```

说明：

- `scripts/build-macos.command` 默认使用 Xcode `Release` 配置构建 Safari 宿主 App，避免 `Debug` 产物注入 `__preview.dylib` / `*.debug.dylib` 导致 Safari 扩展新标签页空白。
- 若本机钥匙串存在 `Apple Development` 证书，`scripts/build-macos.command` 会在 Xcode 构建后自动对 Safari 宿主 App 与 `.appex` 进行二次开发签名，避免 Safari 启动后清空新标签页接管设置。
- 如需临时切回其他配置，可在命令前覆盖环境变量：`SAFARI_XCODE_CONFIGURATION=Debug NO_PAUSE=1 ./scripts/build-macos.command`

执行链：

1. `npm run build` → `bash scripts/build.sh`
2. build.sh 开头调用 `scripts/bump-version.mjs` 自增版本号（可用 `SKIP_BUMP=1` 跳过，如 CI 场景）
3. 按顺序构建三端：

   | 阶段 | 函数 | 做什么 |
   |------|------|--------|
   | Chrome 构建 | `build_chrome` | 复制 `src/` → `dist/chrome/`，写入 `manifest.chrome.json`，打包 `chrome.zip` |
   | Firefox 构建 | `build_firefox` | 复制 `src/` → `dist/firefox/`，调 `bundle-firefox.mjs` 打包 ESM，写入 manifest，打包 `firefox.zip` + `firefox.xpi` |
   | Safari 构建 | `build_safari` | 复制 `src/` → `dist/safari/`，写入 `manifest.safari.json`，打包 `safari.zip` |
   | Safari App（仅 macOS） | `build_safari_app` | 调 `safari-web-extension-converter` 生成 Xcode 工程 → `xcodebuild` 构建 |
   | Safari 安装（仅 macOS） | `install_safari_app` | 复制到 `/Applications/`、`lsregister -u` 去重、启动 App 注册扩展 |

4. 产物输出：
   - `dist/chrome` / `dist/chrome.zip`
   - `dist/firefox` / `dist/firefox.zip` / `dist/firefox.xpi`
   - `dist/safari` / `dist/safari.zip`
   - `dist/safari-app`（仅 macOS，Safari 宿主 App Xcode 工程）

## 11.3 Firefox 特别说明

Firefox 使用 Manifest V3。由于 Firefox 扩展 CSP 对 ESM 模块加载有限制，新标签页按钮点击无响应通常是脚本未执行。当前实现已采用：

- `scripts/bundle-firefox.mjs` 把多个 ESM 模块（`shared-utils.js` / `data-utils.js` / `storage.js` / `icons.js` / `bing-wallpaper.js` / `app.js`）合并为单一外部脚本 `dist/firefox/js/app.ff.js`
- 把 `newtab.html` 的模块脚本标签替换为普通 `<script src="js/app.ff.js">`
- CSP 保持 `script-src 'self'`，无需内联脚本哈希
- 构建时对真实模块图做 **经典脚本语法校验**（`vm.Script`），残留 `import`/`export` 或全局重名会导致构建失败

**重要：必须加载构建产物 `dist/firefox`，不要直接加载 `src/`。** 源码是 ESM；Firefox 新标签页需要的是打包后的 `app.ff.js`。

发布与调试均应以 `dist/firefox` 目录为准加载扩展。

### bundle-firefox.mjs 核心函数

| 函数 | 位置 | 作用 |
|------|------|------|
| `stripImports(code)` | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs#L13-L16) | 移除 ESM import 语句 |
| `stripExports(code)` | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs#L17-L20) | 移除 ESM export 语句 |
| `bundle()` | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs#L21-L33) | 按列表顺序合并多模块为单一文件 |
| `patchHtml()` | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs#L35-L50) | 替换 HTML 中模块脚本标签为普通脚本标签（幂等） |

## 12. 安装方式

## 12.1 Chrome

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 加载已解压的扩展程序 -> 选择 `dist/chrome`

## 12.2 Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 临时载入附加组件 -> 选择 `dist/firefox/manifest.json`

## 12.3 Safari

1. 运行 `NO_PAUSE=1 ./scripts/build-macos.command`
2. 脚本会生成并构建 `dist/safari-app`
3. 自动启动生成出的 `我的首页 Safari.app`
4. 在 Safari 的“设置 -> 高级”开启开发菜单后，到“开发 -> 扩展”里启用对应扩展
5. Safari 版本不声明 `history` 权限，因此“历史”分组会自动退化为空列表，不影响其余功能

## 13. 调试入口

调试接口仅在 `DEBUG` 全局变量为 `true` 的开发构建中暴露，生产构建不可用。定义位置：[src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L885-L925)

- `window.homepageDebugLog()`：读取调试日志（localStorage 存储）。
- `window.homepageDebugEnv()`：查看 runtime 信息与本地存储占用。
- `localStorage.setItem("homepage_debug_persist", "1")`：开启持久化校验日志（调试模式下 persist 后自动回读验证）。
- Popup 保存日志键：`homepage_save_log`（`chrome.storage.local`）。

如需临时启用调试接口，可在控制台执行：`DEBUG = true; location.reload()` 不生效（脚本加载时即判断），需自行在 `src/js/app.js` 顶部添加 `const DEBUG = true;` 后重新构建。

## 14. 已知限制（当前代码行为）

- `enableSearchEngine`、`backgroundFade` 为保留字段，当前逻辑未单独使用。
- 设置面板"隐藏分组"绑定的是 `sidebarHidden`，而顶部"收起"按钮操作的是 `sidebarCollapsed`，两者是不同状态。
- 导入 JSON 仅做 `repairHomepageData` 防御性修复 + 节点 URL 协议白名单，不做完整 schema 校验。
- 搜索框回车/按钮始终新页搜索，不受 `openMode` 影响。
- 调试接口（`homepageDebugLog` / `homepageDebugEnv`）在生产构建中不可用，需手动开启 `DEBUG`。
- **Firefox 版必须加载 `dist/firefox`（打包后的 `app.ff.js`）**；直接加载 `src/` 的 ESM 在 Firefox 扩展 CSP 下不可用。
- Safari 版不声明 `history` 权限，"历史"分组为空列表。
- 图标缓存存储为 dataURL 时体积较大；三端已声明 `unlimitedStorage` 降低 local 配额压力；同步存储仍会触发裁剪（上传图标改为自动）。
- 同步开启时，若远端 key 为空，**不会**用伪造默认数据覆盖本地（`loadDataFromArea` 返回 `null`）。
- 非完整语言包（ja/ko/de/fr/es 等）会回退合并到 `en`/`zh-CN`，界面不会出现大量 raw key。
- 已有自动化测试：`tests/` 覆盖 storage/icons/bing-wallpaper/bump-version/bundle-firefox/data-utils；通过 `npm test` 运行；GitHub Actions CI 自动执行 `npm run check` + `npm test` + `SKIP_BUMP=1 npm run build`。

## 15. 版本策略

- 版本在 `package.json`、`manifest.chrome.json`、`manifest.firefox.json`、`manifest.safari.json` 四端保持一致。
- 每次构建会自动执行 **+0.1（满十进一）**。

### 具体实现机制

| 环节 | 文件 | 说明 |
|------|------|------|
| 版本号计算逻辑 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs#L7-L15) | `bumpVersion()` 函数：拆分为 major.minor 两段，minor + 1，满十进一到 major |
| 批量更新文件 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs#L17-L28) | `run()` 函数：遍历 `files` 数组（4 个文件），读取 JSON → 改 version → 写回 |
| 构建触发点 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh#L14-L18) | build.sh 开头调用 `node scripts/bump-version.mjs`，在复制资源前先改版本号 |
| 跳过方式 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh#L14-L18) | 设环境变量 `SKIP_BUMP=1` 可跳过（CI / 调试场景用） |
| 入口 | [package.json](file:///Users/x/code/homepage/package.json) | `npm run build` → `bash scripts/build.sh`，不再用 prebuild 钩子 |

### 举例

- `16.9` → `17.0`（9+1=10，进一位）
- `17.0` → `17.1`
- `17.9` → `18.0`

---

如果你要继续扩展本项目，建议先从以下文件入手：

- 交互主逻辑：`src/js/app.js`
- 存储与配额：`src/js/storage.js`
- 图标系统：`src/js/icons.js`
- Firefox 构建关键：`scripts/bundle-firefox.mjs`
- Safari 构建关键：`manifest.safari.json`、`scripts/build-macos.command`

---

## 16. 开发者地图（功能 → 代码位置速查）

> 帮助快速定位功能对应的代码位置，便于二次开发。

### 16.1 应用入口与初始化

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 新标签页入口 HTML | [src/newtab.html](file:///Users/x/code/homepage/src/newtab.html) | `<script type="module" src="js/app.js">` |
| 加载失败兜底提示 | [src/js/error-bootstrap.js](file:///Users/x/code/homepage/src/js/error-bootstrap.js) | 内联于 `<head>`，检测 ESM 加载失败 |
| Popup 入口 HTML | [src/popup.html](file:///Users/x/code/homepage/src/popup.html) | `<script type="module" src="popup.js">` |
| 应用初始化 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `init()`（文件末尾自执行） |
| 初始渲染流程 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3742-L3810) | `init()` 内的串行步骤 |

### 16.2 状态与数据

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 全局状态变量 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `let data`、`let state`（文件顶部） |
| 数据默认值 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L87-L123) | `DEFAULT_SETTINGS`、`defaultData()` |
| 数据读写封装 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `loadData()` / `saveData()` / `clearData()` |
| 本地 vs 同步存储 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L200-L276) | `loadData()` 内的 lastUpdated 比较策略 |
| 数据迁移框架 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L277-L328) | `migrateData()` + `MIGRATIONS` 注册表 |
| 配额与降级 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L439-L506) | `handleQuotaError()` 逐级清理 |
| 同步数据清洗 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js#L330-L380) | `sanitizeForSync()` |
| 持久化写入 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1228-L1300) | `persistData()`（指纹对比 + 备份 + 二次去重） |
| 备份与恢复 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `pushBackup()` / `restoreBackup()` / `createBackupSnapshot()` |

### 16.3 渲染与界面

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 主渲染函数 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L927-L978) | `render()`（清空 + 重渲染分组栏 + 网格） |
| 网格卡片渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `renderCard()`（item/folder/history 三种类型） |
| 分组侧栏渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `renderGroups()` |
| 主题与密度应用 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `applyTheme()` / `applyDensity()` / `applyFontSize()` |
| 背景设置 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1082-L1096) | `setBackground()`（CSS.escape + 白名单，防 XSS） |
| 搜索过滤 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `searchInput` 事件 + `render()` 过滤 |

### 16.4 拖拽与文件夹

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 鼠标拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `handleCardDragStart` / `handleDropOnTile` |
| 触摸长按拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1685-L1740) | `TOUCH_TILE_LONG_PRESS_MS`（3秒）+ touch 事件组 |
| 分组长按拖拽 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L675-L695) | `TOUCH_GROUP_LONG_PRESS_MS`（260ms） |
| 触摸上下文菜单 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `touchMenuState` + `TOUCH_TILE_CONTEXT_MENU_MS`（1秒） |
| 框选（鼠标拖拽选多个） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `handleBoxSelectStart` / `handleBoxSelectMove`（raf 节流） / `handleBoxSelectEnd` |
| 文件夹创建（拖到图标） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1968-L2038) | `handleDropOnTile()` 内的 `droppedOnIcon` 分支 |
| 文件夹解散 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2040-L2080) | `dissolveFolder(folderId)` |
| 文件夹覆盖层 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1577-L1610) | `openFolder()` / `closeFolder()` |

### 16.5 模态框与设置

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 模态框模板 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2251-L2280) | `openModal()` + `document.createElement` 安全渲染 |
| 添加/编辑卡片 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2282-L2626) | `openAddModal()` / `openEditModal(node)` |
| 设置面板 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2627-L2895) | `openSettingsModal()` + `renderSettingsContent()` |
| 导入导出 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3045-L3178) | `openManualExportModal()` / `openImportModal()` + `importData()` 三种策略 |
| 批量导入网址 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3179-L3276) | `openImportUrlModal()` |
| 备份管理 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3277-L3338) | `openBackupModal()` |
| 删除与撤销 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L2184-L2212) | `deleteNodes()` / `undoDelete()` + `UNDO_TIMEOUT_MS`（10秒） |
| 批量删除 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3858-L3879) | `btnBatchDelete` 点击事件 |

### 16.6 图标系统

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| favicon 候选生成 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js#L101-L200) | `getFaviconCandidates()`（按浏览器排列优先级） |
| 图标缓存（dataURL） | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `_iconCacheMemory` + `loadIconCache()` / `saveIconCache()` |
| 图标加载与尺寸校验 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `probeImage()`（≥16x16 才接受） |
| 预加载缓存 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `preloadAllIcons()`（单次读取，避免渲染循环多次 IO） |
| 批量刷新图标 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js#L417-L470) | `refreshAllIcons()`（6 并发） |
| 失败重试调度 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `retryFailedIconsIfDue()` + `iconRetryHour` 设置 |
| 字母头像生成 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `generateLetterIcon()` / `generateColorIcon()` |
| 图标展示入口 | [src/js/icons.js](file:///Users/x/code/homepage/src/js/icons.js) | `resolveIcon()`（带 preloadedCache 参数优化性能） |

### 16.7 Bing 每日背景

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 获取每日壁纸 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `fetchBingWallpaper()` |
| 背景缓存策略 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `BING_CACHE_KEY`（同日 key）+ `MAX_CACHE_AGE`（6 小时） |
| 缓存读写 | [src/js/bing-wallpaper.js](file:///Users/x/code/homepage/src/js/bing-wallpaper.js) | `getCachedWallpaper()` / `setCachedWallpaper()` |
| 失败回退 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `loadBackground()` 内的三级降级（Bing → 缓存 → 纯色） |

### 16.8 国际化

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 语言列表（设置用） | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L205-L214) | `APP_SUPPORTED_LANGUAGES`（8 种） |
| 翻译函数 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `t(key)` + `I18N` 对象 |
| 语言检测 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `detectPreferredLanguage()` |
| 存储侧语言列表 | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `SUPPORTED_LANGUAGES`、`STORAGE_SUPPORTED_LANGUAGES` |

### 16.9 Popup 与内容脚本

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| Popup 主逻辑 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `init()` + 保存当前页到分组 |
| Popup 获取当前标签页 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `getCurrentTab()`（含 lastError 检查） |
| 固定分组自动保存 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js#L600-L620) | `defaultGroupMode === "fixed"` 时自动关闭 |
| 页面内 Toast | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js) | `showToast()` + `onMessage` 监听 + 注入守卫 |
| Toast 注入守卫 | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js#L18-L48) | `window.__homepageToastInjected` |

### 16.10 历史页

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| 读取最近历史 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L3535-L3570) | `loadRecentHistory()`（7天/24条/URL去重） |
| 历史项添加到快捷 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | `addHistoryItemToShortcuts()` |
| Safari 兼容（无 history 权限） | 运行时自动降级 | 空列表不报错 |

### 16.11 构建系统

| 功能 | 文件 | 关键位置 |
|------|------|---------|
| 主构建脚本 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | 复制资源 + 写 manifest + 打包 + Safari 转换 + 签名 |
| 版本号自增 | [scripts/bump-version.mjs](file:///Users/x/code/homepage/scripts/bump-version.mjs) | `bumpVersion()`（满十进一） |
| 构建入口 | [package.json](file:///Users/x/code/homepage/package.json) | `npm run build` → `bash scripts/build.sh` |
| macOS 一键入口 | [scripts/build-macos.command](file:///Users/x/code/homepage/scripts/build-macos.command) | 含 Xcode 构建 + 开发签名 + 安装到 /Applications + lsregister 去重 |
| Firefox ESM 打包 | [scripts/bundle-firefox.mjs](file:///Users/x/code/homepage/scripts/bundle-firefox.mjs) | `bundle()` 合并 + `patchHtml()` 替换脚本标签 |
| Chrome 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_chrome` 函数 |
| Firefox 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_firefox` 函数 + 调 bundle-firefox.mjs |
| Safari 构建 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `build_safari` + `build_safari_app` + `install_safari_app` |
| Safari Info.plist 补丁 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `fix_safari_extension_info_plist`（加 SFSafariWebsiteAccess） |
| Safari 旧插件清理 | [scripts/build.sh](file:///Users/x/code/homepage/scripts/build.sh) | `cleanup_stale_safari_plugins`（旧 bundle id 注销） |

### 16.12 安全防护

| 功能 | 文件 | 关键位置 |
|------|------|---------|
| XSS：模态框安全渲染 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js) | 统一用 `document.createElement` + `textContent` |
| XSS：背景样式转义 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L1082-L1096) | `setBackground()` 使用 `CSS.escape()` + 白名单 |
| XSS：用户数据进入 DOM | 全部渲染路径 | 标题/URL 均经 `textContent` 或 `setAttribute` |
| 内容脚本重复注入 | [src/js/content-toast.js](file:///Users/x/code/homepage/src/js/content-toast.js#L18-L48) | `window.__homepageToastInjected` 守卫 |
| 错误引导脚本重复注入 | [src/js/error-bootstrap.js](file:///Users/x/code/homepage/src/js/error-bootstrap.js) | `window.__homepageErrorBootstrapInjected` 守卫 |
| 调试接口生产隐藏 | [src/js/app.js](file:///Users/x/code/homepage/src/js/app.js#L885-L906) | `if (typeof DEBUG !== "undefined" && DEBUG)` |
| chrome API 错误检查 | [src/popup.js](file:///Users/x/code/homepage/src/popup.js) | `chrome.runtime.lastError` 检查 |
| 存储读取重试（Safari） | [src/js/storage.js](file:///Users/x/code/homepage/src/js/storage.js) | `storageGet()` 3 次重试 + 递增间隔 |

### 16.13 测试与 CI

| 功能 | 文件 | 说明 |
|------|------|------|
| 存储模块测试 | [tests/storage.test.js](file:///Users/x/code/homepage/tests/storage.test.js) | 15 个用例：语言检测、深拷贝、默认数据、备份、CRUD、迁移 |
| 图标模块测试 | [tests/icons.test.js](file:///Users/x/code/homepage/tests/icons.test.js) | 10 个用例：候选生成、缓存、头像、尺寸校验 |
| Bing 背景测试 | [tests/bing-wallpaper.test.js](file:///Users/x/code/homepage/tests/bing-wallpaper.test.js) | 3 个用例：缓存读写、TTL 过期 |
| 版本号测试 | [tests/bump-version.test.js](file:///Users/x/code/homepage/tests/bump-version.test.js) | 2 个用例：bump 逻辑、满十进一 |
| Firefox 打包测试 | [tests/bundle-firefox.test.js](file:///Users/x/code/homepage/tests/bundle-firefox.test.js) | 6 个用例：strip 函数、bundle、patchHtml 幂等 |
| CI 工作流 | [.github/workflows/ci.yml](file:///Users/x/code/homepage/.github/workflows/ci.yml) | push/PR 触发：`npm run check` + `npm test` |
| 代码风格 | Biome | `npm run check`（lint + format + import 排序） |
